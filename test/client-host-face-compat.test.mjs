/**
 * MAINT-022 回归守护：DSH 0.1.2-rc.1 客户端面演进——connection.api 移除。
 *
 * 宿主事实（三方实证，2026-09-05）：
 *  · dsh-client-connection 0.1.2-rc.1 lib/client.js:4754-4825——connection
 *    handle 仅 isLoopback/generation/state/rpc/reconnect/registerGenerationSource/
 *    start，无 api 字段；旧实现 `const api = ctx.get('connection').api` →
 *    undefined → 页面首次数据调用同步抛 TypeError → dsh-client-ui-renderer
 *    SlotErrorBoundary 捕获（渲染空 div + 条目退位）→ 设置页内容区整页空白
 *    （用户截图 sha256:f3515191，导航项在、内容空）。
 *  · 新面 = dsh-api-remotes typed remote 命名空间：remote.settings
 *    （describe L5051/mutate L5069/replace L5166/update L5216，参数位置化、
 *    响应 {ok, value|error} 直面）+ remote.session.modelCatalog（L8267，
 *    ModelCatalog {default, routableProviders, groups}——groups 形状与旧
 *    api.llm.models 一致）。官方同款先例 dsh-client-ui-settings-models
 *    静态 inject remote.*。
 *  · 同源修复先例：dsh-agent-router FIX-028（f0438f9，用户 2026-09-05 复验
 *    通过）。
 *
 * 本测试以「新宿主形状」fixture 驱动真实 lib/client.js：apply(ctx) 在
 * 无 connection.api、有 remote.settings/remote.session 的 ctx 下必须
 * 注册 settings.section，页面经适配层完成 describe/models/update/mutate
 * 全链；命名空间缺失必须 fail-loud（P8：结构化错误而非裸 TypeError）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { HOST_REMOTE_CONTRACT } from '../lib/host-compat.js'
import { isStructuredFaceError } from './host-probes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 最小 React 桩（与 client-probe-summary.test.mjs 同构）─────────────────
const stores = new Map()
let currentComponent = ''
let hookIndex = 0
function slots() {
  if (!stores.has(currentComponent)) stores.set(currentComponent, [])
  return stores.get(currentComponent)
}
function resetHooks(name) {
  currentComponent = name
  hookIndex = 0
}
const react = {
  createElement(tag, props, ...children) {
    return { $$: typeof tag === 'function' ? 'component' : String(tag), tag, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const store = slots()
    if (store[hookIndex] === undefined) store[hookIndex] = { state: typeof initial === 'function' ? initial() : initial }
    const slot = store[hookIndex]
    hookIndex += 1
    return [slot.state, (value) => { slot.state = typeof value === 'function' ? value(slot.state) : value }]
  },
  useEffect(effect) {
    slots()[hookIndex] = true
    hookIndex += 1
    setTimeout(() => { effect() }, 0)
  },
  useRef(initial) {
    const store = slots()
    if (store[hookIndex] === undefined) store[hookIndex] = { ref: { current: initial } }
    const slot = store[hookIndex]
    hookIndex += 1
    return slot.ref
  },
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 新宿主形状 fixture（0.1.2-rc.1 typed remote 直面）────────────────────
// settings describe 值锚定 dsh-api-remotes settings/describe result schema
// （writable/hasDocument/namespaces[{ns, schema, value, base?, user?, applies,
// secrets[{path,set}], revision}]——R0-F5：必填字段全量保真）。
const DESCRIBE_VALUE = {
  writable: true,
  hasDocument: true,
  namespaces: [
    { ns: 'llm-reasoning', schema: null, value: { enabled: true, level: 'high', models: { 'demo/m1': 'low' }, purposes: {}, syncDefaultAgent: false, statsPublic: false }, applies: 'live', secrets: [], revision: 1 },
    { ns: 'llm-pi-ai', schema: null, value: { providers: { demo: { reasoning: 'high', models: [{ id: 'm1', reasoningEfforts: { low: 'low', high: 'high' } }] } } }, applies: 'live', secrets: [], revision: 1 },
    { ns: 'llm-deepseek', schema: null, value: { reasoningEffort: 'max' }, applies: 'live', secrets: [], revision: 1 },
  ],
}
// modelCatalog 值锚定 session/modelCatalog result schema（groups 形状与旧
// api.llm.models 的 groups 一致：id/name/models[].reasoning.efforts[].id）。
const CATALOG_VALUE = {
  default: { provider: 'demo', model: 'm1', reasoningEffort: 'high' },
  routableProviders: ['demo'],
  groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] }],
}

function newHostCtx({ calls } = {}) {
  // MAINT-025 F3：桩升级为元数记录桩——rest 参数记录 [方法, 实传元数, ...实参]。
  // 旧桩 `async (ns, patch)` 是普通 JS 函数，多传少传都不报错（元数盲区 =
  // MAINT-025 假绿机理，RCA 5-Why 第 3 层）；元数断言在用例内完成，违约即红。
  // 桩形状锚定宿主描述符（dsh-api-remotes 0.1.2-rc.1：update/mutate 三参），
  // 非适配层假设；真实工件判别另见 test/host-face-contract.test.mjs。
  const remoteSettings = {
    describe: async () => (calls?.push('settings.describe'), { ok: true, value: DESCRIBE_VALUE }),
    update: async (...args) => (calls?.push(['settings.update', args.length, ...args]), { ok: true, value: { ns: args[0], value: args[1] } }),
    mutate: async (...args) => (calls?.push(['settings.mutate', args.length, ...args]), { ok: true, value: { ns: args[0], value: {} } }),
  }
  const remoteSession = {
    modelCatalog: async () => (calls?.push('session.modelCatalog'), { ok: true, value: CATALOG_VALUE }),
  }
  return {
    get: (name) => {
      if (name === 'remote.settings') return remoteSettings
      if (name === 'remote.session') return remoteSession
      if (name === 'locale') return { getSnapshot: () => ({ active: 'zh' }) }
      // 0.1.2-rc.1：connection 服务仍在（isLoopback/state/...），但无 api 字段
      if (name === 'connection') return { isLoopback: true, reconnect() {} }
      return undefined
    },
    slots: null,
  }
}

const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({ since: Date.now(), totalCalls: 0, models: {}, recent: [], blacklist: {} }) })

function loadClient() {
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { sandbox.__loaded = def } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    fetch: fetchStub,
    AbortController,
  }
  vm.runInNewContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
  const client = sandbox.__loaded
  assert.ok(client && client.id === 'dsh-reasoning-level', 'client module must load')
  return client.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })
}

function applyToRegistry(factoryExports, ctx) {
  const registered = []
  ctx.slots = {
    inject: (_slot, provider) => provider(),
    register: (meta, render) => { registered.push({ meta, render }); return () => {} },
  }
  factoryExports.apply(ctx)
  return registered
}

function collectComponents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && typeof node.tag === 'function' && node.tag.name && !into.some(([n]) => n === node.tag.name)) {
    into.push([node.tag.name, node.tag, node.props])
  }
  for (const child of node.children ?? []) collectComponents(child, into)
  collectComponents(node.props?.children, into)
}

function findText(node, needle, depth = 0) {
  if (node === null || node === undefined || depth > 40) return false
  if (typeof node === 'string') return node.includes(needle)
  if (typeof node !== 'object') return false
  // 卡片标题经组件 prop 传递（el(Card, { title })），不在文本子树里
  if (typeof node.props?.title === 'string' && node.props.title.includes(needle)) return true
  for (const child of node.children ?? []) if (findText(child, needle, depth + 1)) return true
  return findText(node.props?.children, needle, depth + 1)
}

function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.$$ === 'button' && (node.children ?? []).includes(label) && typeof node.props?.onClick === 'function') return node
  for (const child of node.children ?? []) { const r = findButton(child, label); if (r) return r }
  return findButton(node.props?.children, label)
}

test('(MAINT-022) 模块 inject 声明新面命名空间、不再依赖 connection — // TDD-GUARD-MAINT-022', () => {
  const factoryExports = loadClient()
  // FEAT-002：期望值消费 lib/host-compat.js 契约常量（单一清单——本断言是
  // client 工件导出面 vs 注册表的跨工件一致性检查，与镜像段单源域同向）。
  assert.deepEqual(
    [...factoryExports.inject].sort(),
    [...HOST_REMOTE_CONTRACT.clientInject].sort(),
    'client inject must wait on remote.settings/remote.session (官方先例 dsh-client-ui-settings-models) and drop the dead connection path',
  )
})

test('(MAINT-022) apply 在新宿主形状（connection 无 api）下注册 settings.section — // TDD-GUARD-MAINT-022', () => {
  const factoryExports = loadClient()
  const ctx = newHostCtx()
  const registered = applyToRegistry(factoryExports, ctx)
  assert.equal(registered.length, 1, 'exactly one settings.section must register (旧实现在此早退 → 0，即用户截图的空白页)')
  assert.equal(registered[0].meta.name, 'settings.section')
  assert.equal(registered[0].meta.id, 'reasoning-level')
})

test('(MAINT-022) 页面经适配层完成 describe 全链（设置卡渲染、非 loading 态）— // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const calls = []
  const ctx = newHostCtx({ calls })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag
  const pageProps = pageElement.props

  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  const tree = pageTag(pageProps)
  await sleep(10)

  assert.ok(calls.includes('settings.describe'), 'remote.settings.describe 必须被调用')
  assert.ok(!findText(tree, '加载中'), '页面必须离开 loading 态（describe 数据经旧信封正确落入 view）')
  assert.ok(findText(tree, '全局设置'), '全局设置卡必须渲染')
  assert.ok(findText(tree, '模型级默认'), '模型级默认卡必须渲染')
})

test('(MAINT-022) ModelDefaults 经 session.modelCatalog 加载模型列表 — // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const calls = []
  const ctx = newHostCtx({ calls })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag
  const pageProps = pageElement.props

  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  const pageTree = pageTag(pageProps)
  await sleep(10)

  const components = []
  collectComponents(pageTree, components)
  const modelDefaults = components.find(([name]) => name === 'ModelDefaults')
  assert.ok(modelDefaults, 'ModelDefaults must be reachable')
  const [, fn, props] = modelDefaults
  resetHooks('ModelDefaults'); fn(props); await sleep(10)
  resetHooks('ModelDefaults')
  const tree = fn(props)
  await sleep(10)
  assert.ok(calls.includes('session.modelCatalog'), 'remote.session.modelCatalog 必须被调用（ModelDefaults 数据面）')
  // 模型下拉含 demo/m1（catalog groups 经适配层映射为旧 llm.models 信封）
  const options = []
  ;(function collectOptions(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.$$ === 'option' && typeof node.props?.value === 'string') options.push(node.props.value)
    for (const child of node.children ?? []) collectOptions(child)
    collectOptions(node.props?.children)
  })(tree)
  assert.ok(options.includes('demo/m1'), '模型下拉必须包含 catalog 中的 demo/m1，实际：' + JSON.stringify(options))
})

test('(MAINT-022) change 经 remote.settings.update（全局等级变更）— // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const calls = []
  const ctx = newHostCtx({ calls })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag
  const pageProps = pageElement.props

  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  pageTag(pageProps); await sleep(10)

  const updateCall = calls.find((c) => Array.isArray(c) && c[0] === 'settings.update')
  assert.ok(!updateCall, '无变更不应触发 update（前置）')

  // 从树中找到 level 下拉的 onChange（全局默认等级选择器）
  let levelSelect = null
  resetHooks('ReasoningPage')
  ;(function find(node) {
    if (node === null || node === undefined || typeof node !== 'object' || levelSelect) return
    if (node.$$ === 'select' && typeof node.props?.onChange === 'function' && Array.isArray(node.children) && node.children.some((c) => typeof c === 'object' && c.$$ === 'option' && c.props?.value === 'xhigh')) levelSelect = node.props
    for (const child of node.children ?? []) find(child)
    find(node.props?.children)
  })(pageTag(pageProps))
  assert.ok(levelSelect, '全局等级下拉必须存在')

  levelSelect.onChange({ target: { value: 'medium' } })
  await sleep(20)
  const update = calls.find((c) => Array.isArray(c) && c[0] === 'settings.update')
  assert.ok(update, '选择等级必须经 remote.settings.update')
  // MAINT-025 F3：记录形状 = [kind, 实传元数, ...实参]
  assert.equal(update[2], 'llm-reasoning', 'update ns 必须是 llm-reasoning')
  assert.equal(update[3].level, 'medium', 'update patch 必须携带新等级')
})

test('(MAINT-025) 写路径三参判别：update/mutate 必须按宿主 0.1.2-rc.1 元数契约三参转发（第三参显式占位）— // TDD-GUARD-MAINT-025', async () => {
  const factoryExports = loadClient()
  const calls = []
  const ctx = newHostCtx({ calls })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag
  const pageProps = pageElement.props

  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  pageTag(pageProps); await sleep(10)

  // 写路径①：全局等级下拉 → update（change({level}) 调用形状锚定 lib/client.js:818）
  let levelSelect = null
  resetHooks('ReasoningPage')
  ;(function find(node) {
    if (node === null || node === undefined || typeof node !== 'object' || levelSelect) return
    if (node.$$ === 'select' && typeof node.props?.onChange === 'function' && Array.isArray(node.children) && node.children.some((c) => typeof c === 'object' && c.$$ === 'option' && c.props?.value === 'xhigh')) levelSelect = node.props
    for (const child of node.children ?? []) find(child)
    find(node.props?.children)
  })(pageTag(pageProps))
  assert.ok(levelSelect, '全局等级下拉必须存在')
  levelSelect.onChange({ target: { value: 'low' } })
  await sleep(20)

  // 元数契约：宿主描述符 update = [ns, patch, expectedRevision]（api-remotes:5216-5253），
  // 客户端网关严格守卫（dsh-api-gateway lib/client.js:1626-1633）——2 参转发即
  // RPC 前 throw「expected 3 argument(s), got 2」（MAINT-025 根因本体）。
  const update = calls.find((c) => Array.isArray(c) && c[0] === 'settings.update')
  assert.ok(update, '等级变更必须经 remote.settings.update')
  assert.equal(update[1], 3, 'update 实传元数必须为 3（ns, patch, expectedRevision）——2 参转发 = MAINT-025 根因')
  assert.equal(update[2], 'llm-reasoning', 'update ns 必须是 llm-reasoning')
  assert.equal(update[3].level, 'low', 'update patch 必须携带新等级')
  assert.equal(update[4], undefined, 'expectedRevision 占位值 undefined = 无条件写入（dsh-api-settings-controller lib/index.js:443；乐观并发为后续独立任务）')

  // 写路径②：删除模型级默认 → mutate（removeEntry 调用形状锚定 lib/client.js:770-771）
  const settings = ctx.get('remote.settings')
  settings.describe = async () => ({ ok: true, value: DESCRIBE_VALUE })
  resetHooks('ReasoningPage')
  const tree = pageTag(pageProps)
  await sleep(10)
  const components = []
  collectComponents(tree, components)
  const modelDefaults = components.find(([name]) => name === 'ModelDefaults')
  assert.ok(modelDefaults, 'ModelDefaults must be reachable')
  const [, fn, props] = modelDefaults
  resetHooks('ModelDefaults'); fn(props); await sleep(10)
  resetHooks('ModelDefaults')
  const mdTree = fn(props)
  await sleep(10)
  const delBtn = findButton(mdTree, '删除')
  assert.ok(delBtn, '删除按钮必须存在（models 配置行）')
  delBtn.props.onClick()
  await sleep(20)

  const mutate = calls.find((c) => Array.isArray(c) && c[0] === 'settings.mutate')
  assert.ok(mutate, '删除模型默认必须经 remote.settings.mutate')
  assert.equal(mutate[1], 3, 'mutate 实传元数必须为 3（ns, ops, expectedRevision）——2 参转发 = MAINT-025 根因')
  assert.equal(mutate[2], 'llm-reasoning', 'mutate ns 必须是 llm-reasoning')
  assert.equal(
    JSON.stringify(mutate[3]),
    JSON.stringify([{ op: 'unset', path: ['models', 'demo/m1'] }]),
    'mutate ops 必须是 unset [models, key]（形状锚定 api-remotes:4771-4774）',
  )
  assert.equal(mutate[4], undefined, 'expectedRevision 占位值 undefined（无条件写入）')
})

test('(MAINT-022) remote 命名空间缺失时 fail-loud（结构化错误，非裸 TypeError）— // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const ctx = newHostCtx()
  // 剥离 remote.*（模拟宿主版本不兼容：命名空间未挂载）
  const get = ctx.get
  ctx.get = (name) => (name.startsWith('remote.') ? undefined : get(name))
  const registered = applyToRegistry(factoryExports, ctx)
  assert.equal(registered.length, 1, '注册不受影响（适配层惰性解析）')

  // 适配层 api 在命名空间缺失时的行为：Promise 拒绝并携带结构化原因
  // （页面 .catch 显示「读取失败」；禁止裸 "Cannot read properties of undefined"）
  // FEAT-002：结构化判据消费 test/host-probes.mjs 的唯一实现点（与 doctor 条目
  // 11 同源——判据零分叉）；本用例保留页面级驱动路径（render → props.api）。
  const api = registered[0].render({}).props.api
  assert.ok(api && api.settings, '渲染 props 必须携带适配层 api')
  await assert.rejects(
    () => api.settings.describe({}),
    (error) => {
      assert.ok(isStructuredFaceError(error), `错误必须可归属本插件并指明宿主命名空间缺失：${String(error?.message).slice(0, 120)}`)
      return true
    },
  )
})

test('(MAINT-022/R0-F2) 删除模型默认经 remote.settings.mutate（ns + unset ops 位置参数）— // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const calls = []
  const ctx = newHostCtx({ calls })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag
  const pageProps = pageElement.props

  // describe 值含 models: {'demo/m1':'low'} → 模型级默认表有配置行
  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  const tree1 = pageTag(pageProps)
  await sleep(10)

  const components = []
  collectComponents(tree1, components)
  const modelDefaults = components.find(([name]) => name === 'ModelDefaults')
  assert.ok(modelDefaults, 'ModelDefaults must be reachable')
  const [, fn, props] = modelDefaults
  resetHooks('ModelDefaults'); fn(props); await sleep(10)
  resetHooks('ModelDefaults')
  const mdTree = fn(props)
  await sleep(10)

  // 找到 demo/m1 配置行的「删除」按钮（按钮文案 '删除'）
  const delBtn = findButton(mdTree, '删除')
  assert.ok(delBtn, '删除按钮必须存在（models 配置行）')
  delBtn.props.onClick()

  const mutate = calls.find((c) => Array.isArray(c) && c[0] === 'settings.mutate')
  assert.ok(mutate, '删除模型默认必须经 remote.settings.mutate（update 深合并无法删键）')
  // MAINT-025 F3：记录形状 = [kind, 实传元数, ...实参]
  assert.equal(mutate[2], 'llm-reasoning', 'mutate ns 必须是 llm-reasoning')
  // ops 数组产自 vm 沙箱内（原型域不同），deepStrictEqual 误报——用 JSON 形状比较
  assert.equal(
    JSON.stringify(mutate[3]),
    JSON.stringify([{ op: 'unset', path: ['models', 'demo/m1'] }]),
    'mutate ops 必须是 unset [models, key]（形状锚定 api-remotes:4771-4774）',
  )
})

test('(MAINT-022/R0-F1) describe 失败时错误文本进入页面（loading 态渲染 notice，不停在「加载中…」）— // TDD-GUARD-MAINT-022', async () => {
  const factoryExports = loadClient()
  const ctx = newHostCtx()
  // 覆写 describe 为信封失败（ok:false + error.message）
  const settings = ctx.get('remote.settings')
  settings.describe = async () => ({ ok: false, error: { message: '宿主 settings 命名空间拒绝：演示错误' } })
  const registered = applyToRegistry(factoryExports, ctx)
  const pageElement = registered[0].render({})
  const pageTag = pageElement.tag

  resetHooks('ReasoningPage'); pageTag(pageElement.props); await sleep(10)
  resetHooks('ReasoningPage')
  const tree = pageTag(pageElement.props)
  await sleep(10)

  // view 恒 null（describe 失败）→ 页面必须渲染「读取失败：…」而非永远「加载中…」
  assert.ok(findText(tree, '读取失败'), '错误提示必须可见（R0-F1：notice 需在 loading 态渲染）')
  assert.ok(findText(tree, '演示错误'), '宿主错误文本必须透出（信封 error.message）')
  assert.ok(!findText(tree, '加载中'), '失败后不得停留在无差别 loading 态')
})
