/**
 * MAINT-025 判别测试（真实工件判别——禁止桩对桩自证）。
 *
 * 背景（docs/retro/rca-MAINT-025.md）：MAINT-022 的 hostApiFace 适配层把
 * remote.settings.update/mutate 按 2 个位置参数转发（lib/client.js:910/914），
 * 宿主 0.1.2-rc.1 描述符要求 3 参（ns, patch/ops, expectedRevision），客户端
 * 网关在 RPC 前执行严格元数守卫（dsh-api-gateway lib/client.js:1626-1633）
 * → 每次设置写入确定性 throw，被 change() catch 吞成「保存失败」。
 * 47/47 全绿未拦住本缺陷的直接原因：旧测试/冒烟的 remote 桩是普通 JS 函数，
 * 不校验元数，且桩形状抄自适配层自身假设（桩 ↔ 适配层循环自证，RCA 5-Why
 * 第 3 层）。本判别测试改用**真实宿主工件**：
 *
 *   Half A（宿主侧）：vm 加载 devDeps/宿主 checkout 锁版 dsh-api-remotes
 *           真实 bundle，经真实 apply() → ctx.remote.$mount 捕获全部 12 个
 *           真实 contribution，提取 4 个目标方法的**真实描述符元数**；
 *   Half B（插件侧）：加载真实插件 lib/client.js，捕获适配层对每个方法的
 *           **实传参数量**（记录型 fake remote 用 rest 参数捕获 arguments）；
 *   断言：逐方法 实传元数 === 真实描述符 parameters.length + 实传形状
 *           （ns string / patch 对象 / ops 数组 / 第三参显式占位）；
 *   守卫对照：用真实描述符 + 逐字复制的 gateway 元数守卫驱动正反例——
 *           2 参写调用必被拒（负对照）、3 参含显式 undefined 必放行（正对照）。
 *
 * 效果：任何宿主 bump 或适配层漂移导致的元数/形状断裂在 CI 即红，不依赖
 * 浏览器（RCA §8-a）。本文件在**未修复**代码上必须 RED（update/mutate
 * 2≠3），F1 修复后 GREEN——RED→GREEN 双向证明是判别测试成立的前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 契约锚：本套件针对的宿主版本。宿主升级任务的固定流程（RCA §8-c 配套
// SOP）= 更新此锚 + 解析链候选②的锁版 + 重跑本判别组，一个 commit 承载
// 一个宿主版本。
const EXPECTED_HOST_VERSION = '0.1.2-rc.1'

// ── 真实工件解析（fail-closed：找不到匹配版本的真实包即失败，绝不跳过）──
// 解析链：
//   ① DSH_HOST_PACKAGES 环境变量——指向含 @deepseek-ai/ 的 node_modules 目录；
//   ② 工作区 node_modules——devDeps 精确锁版后自动生效（MAINT-021 先例）；
//   ③ 本机宿主 checkout（%LocalAppData%\npm-cache\_npx\*\node_modules）——
//     按 package.json version === 锚版本过滤，多命中取第一个，命中零个即失败。
function resolveRealPackage(packageName) {
  const scoped = join('@deepseek-ai', packageName)
  const candidates = []
  if (process.env.DSH_HOST_PACKAGES) candidates.push(join(process.env.DSH_HOST_PACKAGES, scoped))
  candidates.push(join(root, 'node_modules', scoped))
  const npxCache = join(process.env.LocalAppData ?? '', 'npm-cache', '_npx')
  if (process.env.LocalAppData && existsSync(npxCache)) {
    for (const entry of readdirSync(npxCache)) candidates.push(join(npxCache, entry, 'node_modules', scoped))
  }
  const seen = []
  for (const dir of candidates) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    seen.push(`${packageName}@${pkg.version} (${dir})`)
    if (pkg.version === EXPECTED_HOST_VERSION) {
      return { dir, version: pkg.version, clientFile: join(dir, 'lib', 'client.js') }
    }
  }
  throw new Error(
    `host-face-contract: 未找到 ${packageName}@${EXPECTED_HOST_VERSION} 真实工件（fail-closed，禁止降级为桩）。` +
    `已扫描：\n  ${seen.join('\n  ') || '(无候选)'}\n` +
    `处置：设 DSH_HOST_PACKAGES 指向宿主 node_modules，或在 devDeps 精确锁版 ${packageName}@${EXPECTED_HOST_VERSION}（RCA §8-a）。`,
  )
}

const API_REMOTES = resolveRealPackage('dsh-api-remotes')

// 判别目标：适配层消费的全部 4 个数据面方法（RCA §1/#12/#13 + §6——泛化到
// 整类元数断裂，不只护 update 一个点）。id 锚定真实 bundle 内描述符。
const TARGET_METHODS = [
  { key: 'settings.describe', id: '@deepseek-ai/dsh-api-settings-controller#settings/describe' },
  { key: 'settings.update', id: '@deepseek-ai/dsh-api-settings-controller#settings/update' },
  { key: 'settings.mutate', id: '@deepseek-ai/dsh-api-settings-controller#settings/mutate' },
  { key: 'session.modelCatalog', id: '@deepseek-ai/dsh-api-session-controller#session/modelCatalog' },
]

// ── Half A：vm 加载真实 dsh-api-remotes bundle，捕获真实描述符 ────────────
// bundle 形态与插件 client.js 同构（window.__ModuleLoader__.load，自包含
// 零 require——实读确认）；真实 apply() 仅需 ctx.remote.$mount（bundle 尾部
// apply 实读确认），捕获桩按真实契约返回 async disposer。
async function loadHostContributions() {
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(def) { loaded = def } } } }
  vm.runInNewContext(readFileSync(API_REMOTES.clientFile, 'utf8'), sandbox, { filename: API_REMOTES.clientFile })
  assert.ok(loaded && loaded.id === '@deepseek-ai/dsh-api-remotes', 'host api-remotes bundle must load through ModuleLoader contract')
  const exports = loaded.factory(() => { throw new Error('host api-remotes bundle required unexpected module') })
  const contributions = []
  const disposer = await exports.apply({
    remote: { $mount: async (contribution) => { contributions.push(contribution); return async () => {} } },
  })
  assert.equal(contributions.length, 12, '真实 apply() 必须挂载 12 个 contribution（RCA §3 Half A 实测基线）')
  await disposer()
  return contributions
}

function descriptorOf(contributions, id) {
  for (const contribution of contributions) {
    for (const descriptor of contribution.descriptors ?? []) {
      if (descriptor.id === id) return descriptor
    }
  }
  return null
}

// ── Half B：加载真实插件 client.js，记录型 fake remote 捕获实传元数 ──────
// （vm dual-face 加载器与 test/client-host-face-compat.test.mjs 同构。）
const DESCRIBE_VALUE = {
  writable: true,
  hasDocument: true,
  namespaces: [
    { ns: 'llm-reasoning', schema: null, value: { enabled: true, level: 'high', models: { 'demo/m1': 'low' }, purposes: {}, syncDefaultAgent: false, statsPublic: false }, applies: 'live', secrets: [], revision: 1 },
  ],
}
const CATALOG_VALUE = {
  default: { provider: 'demo', model: 'm1', reasoningEffort: 'high' },
  routableProviders: ['demo'],
  groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] }],
}

const react = {
  createElement(tag, props, ...children) {
    return { $$: typeof tag === 'function' ? 'component' : String(tag), tag, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useRef(initial) { return { ref: { current: initial } } },
}

// 记录型 fake remote：rest 参数捕获实传 argument 个数与值（普通具名参数桩
// 无法暴露元数违约——MAINT-025 假绿机理，RCA 5-Why 第 3 层）。
function recordingRemoteFaces(calls) {
  return {
    remoteSettings: {
      describe: async (...args) => { calls.push(['settings.describe', args.length, ...args]); return { ok: true, value: DESCRIBE_VALUE } },
      update: async (...args) => { calls.push(['settings.update', args.length, ...args]); return { ok: true, value: { ns: args[0], value: {} } } },
      mutate: async (...args) => { calls.push(['settings.mutate', args.length, ...args]); return { ok: true, value: { ns: args[0], value: {} } } },
    },
    remoteSession: {
      modelCatalog: async (...args) => { calls.push(['session.modelCatalog', args.length]); return { ok: true, value: CATALOG_VALUE } },
    },
  }
}

function loadPluginAdapter(calls) {
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { loaded = def } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ since: Date.now(), totalCalls: 0, models: {}, recent: [], blacklist: {} }) }),
    AbortController,
  }
  vm.runInNewContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
  assert.ok(loaded && loaded.id === 'dsh-reasoning-level', 'plugin client module must load')
  const client = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })
  const faces = recordingRemoteFaces(calls)
  const registered = []
  client.apply({
    get: (name) => (name === 'remote.settings' ? faces.remoteSettings
      : name === 'remote.session' ? faces.remoteSession
      : name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject: (_slot, provider) => provider(),
      register: (meta, render) => { registered.push({ meta, render }); return () => {} },
    },
  })
  assert.equal(registered.length, 1, 'apply 必须注册唯一 settings.section')
  const api = registered[0].render({}).props.api
  assert.ok(api && api.settings && api.llm, 'section element 必须携带适配层 api')
  return api
}

// 以页面真实调用形状驱动适配层全部 4 个数据面方法（change() 调用形状锚定
// lib/client.js:766-772——页面不传 expectedRevision，由适配层补第三参占位）。
async function driveAdapter(api) {
  await api.settings.describe({})
  await api.settings.update({ ns: 'llm-reasoning', patch: { level: 'medium' } })
  await api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', 'demo/m1'] }] })
  await api.llm.models()
}

// ── 逐字复制 dsh-api-gateway lib/client.js:1626-1633（prepareInvocation 元数
// 守卫段）。唯一替换：endpointOf(descriptor) → descriptor.id（直调用面
// endpoint 即 descriptor.id——RCA §3 Half A 同款消息保真替换）；直调用时
// projection 恒 undefined。禁止"改写收敛"——守卫逐字保真才具备判别力。
function gatewayArityGuard(descriptor, values) {
  const endpoint = descriptor.id
  const projection = void 0
  const expected = descriptor.parameters.length - (projection?.parameterIndex === void 0 ? 0 : 1)
  const hasCallerSignal = descriptor.cancellation !== void 0 && values.length === expected + 1
  if (values.length !== expected && !hasCallerSignal) {
    const contract = descriptor.cancellation === void 0
      ? `${String(expected)} argument(s)`
      : `${String(expected)} business argument(s) plus an optional AbortSignal`
    throw new Error(`client api: ${endpoint} expected ${contract}, got ${String(values.length)}`)
  }
  return { endpoint, expected }
}

// ── 宿主契约锚（对真实 bundle 的快照断言——宿主 bump 即此处红）──────────
test('(MAINT-025) 真实 dsh-api-remotes@0.1.2-rc.1 描述符契约锚：describe/modelCatalog 零参、update/mutate 三参且第三参 acceptsUndefined — // TDD-GUARD-MAINT-025', async () => {
  const contributions = await loadHostContributions()
  const describe = descriptorOf(contributions, TARGET_METHODS[0].id)
  const update = descriptorOf(contributions, TARGET_METHODS[1].id)
  const mutate = descriptorOf(contributions, TARGET_METHODS[2].id)
  const modelCatalog = descriptorOf(contributions, TARGET_METHODS[3].id)
  for (const [name, descriptor] of [['describe', describe], ['update', update], ['mutate', mutate], ['modelCatalog', modelCatalog]]) {
    assert.ok(descriptor, `真实 bundle 必须含 ${name} 描述符`)
  }
  // 跨 realm 注意：descriptor 产自 vm realm，其 Array 原型与本地不同——
  // deepStrictEqual 对空数组也会误报；统一经 Array.from 拷贝进本地 realm 再比较。
  assert.equal(describe.parameters.length, 0, 'settings.describe 真实元数 = 0 参（api-remotes:5056）')
  assert.equal(modelCatalog.parameters.length, 0, 'session.modelCatalog 真实元数 = 0 参（api-remotes:8272）')
  for (const [name, descriptor, params] of [
    ['settings.update', update, ['ns', 'patch', 'expectedRevision']],
    ['settings.mutate', mutate, ['ns', 'ops', 'expectedRevision']],
  ]) {
    assert.deepEqual(Array.from(descriptor.parameters.map((p) => p.name)), params, `${name} 真实参数表 = ${params.join(', ')}（第三参必须占位）`)
    assert.equal(descriptor.parameters[2].acceptsUndefined, true, `${name} 第三参 expectedRevision acceptsUndefined=true——undefined 合法但必须显式占位（api-remotes:5099/5246）`)
    assert.equal(descriptor.cancellation, undefined, `${name} 无 cancellation——网关 expected = parameters.length（gateway:1628-1629）`)
  }
})

// ── 判别核心（本测试在未修复代码上必须 RED）────────────────────────────
test('(MAINT-025) 判别核心：适配层实传元数 === 真实描述符元数（describe/update/mutate/modelCatalog 逐方法 + 实传形状）— // TDD-GUARD-MAINT-025', async () => {
  const contributions = await loadHostContributions()
  const calls = []
  await driveAdapter(loadPluginAdapter(calls))

  const rows = TARGET_METHODS.map(({ key, id }) => {
    const descriptor = descriptorOf(contributions, id)
    assert.ok(descriptor, `真实 bundle 必须含 ${id} 描述符`)
    const call = calls.find((entry) => entry[0] === key)
    assert.ok(call, `适配层必须调用 ${key}（判别驱动覆盖缺失）`)
    return { key, id, descriptor, forwardedCount: call[1], forwardedArgs: call.slice(2) }
  })

  const table = rows.map(({ key, descriptor, forwardedCount }) =>
    `  ${key.padEnd(20)} forwarded=${forwardedCount} descriptor=${descriptor.parameters.length}${forwardedCount === descriptor.parameters.length ? '' : '  ← MISMATCH'}`,
  ).join('\n')

  // 元数判别（RED→GREEN 翻转点：修复前 update/mutate 行为 MISMATCH）
  for (const { key, id, descriptor, forwardedCount } of rows) {
    assert.equal(
      forwardedCount, descriptor.parameters.length,
      `${key} 元数断裂：适配层实传 ${forwardedCount} 参，真实描述符 ${descriptor.parameters.length} 参（${id}）。\n` +
      `宿主网关元数守卫（dsh-api-gateway lib/client.js:1626-1633）在 RPC 前即 throw——即「保存失败」根因。\n全部方法比对：\n${table}`,
    )
  }

  // 实传形状判别（RCA §8-a-4）
  const describe = rows[0]
  const update = rows[1]
  const mutate = rows[2]
  const modelCatalog = rows[3]
  assert.equal(typeof update.forwardedArgs[0], 'string', 'update 第一参 ns 必须是 string（描述符 mutate:ns=string，api-remotes:4758 同族）')
  assert.equal(update.forwardedArgs[0], 'llm-reasoning', 'update ns 必须是 llm-reasoning')
  assert.ok(update.forwardedArgs[1] && typeof update.forwardedArgs[1] === 'object' && !Array.isArray(update.forwardedArgs[1]), 'update 第二参 patch 必须是普通对象')
  assert.equal(mutate.forwardedArgs[0], 'llm-reasoning', 'mutate ns 必须是 llm-reasoning')
  assert.ok(Array.isArray(mutate.forwardedArgs[1]), 'mutate 第二参 ops 必须是数组')
  assert.deepEqual(
    JSON.parse(JSON.stringify(mutate.forwardedArgs[1])),
    [{ op: 'unset', path: ['models', 'demo/m1'] }],
    'mutate ops 形状锚定 api-remotes:4759-4774（op:set{path,value}/op:unset{path}）',
  )
  // 写路径第三参显式占位（rest 参数长度 3 = 显式传了 undefined；透传省略 =
  // 2 参 = 本缺陷本体。值可 undefined——宿主语义 "undefined writes
  // unconditionally"（dsh-api-settings-controller lib/index.js:443/454/467）。
  for (const { key, forwardedArgs } of [update, mutate]) {
    assert.equal(forwardedArgs.length, 3, `${key} 第三参 expectedRevision 必须显式占位（.d.ts number|undefined 非 optional，必须传位；值可 undefined）`)
    assert.ok(forwardedArgs[2] === undefined || (Number.isInteger(forwardedArgs[2]) && forwardedArgs[2] >= 0), `${key} 第三参必须是 undefined 或非负 revision`)
  }
  assert.equal(describe.forwardedCount, 0, 'describe 读路径零参（渲染正常的机理——元数恰配）')
  assert.equal(modelCatalog.forwardedCount, 0, 'modelCatalog 读路径零参')
})

// ── 负/正对照：守卫判别力证明（真实描述符驱动，与修复状态无关，恒绿）────
test('(MAINT-025) 负/正对照：逐字 gateway 元数守卫拒绝 2 参写调用、放行 3 参（含显式 undefined）— // TDD-GUARD-MAINT-025', async () => {
  const contributions = await loadHostContributions()
  const update = descriptorOf(contributions, TARGET_METHODS[1].id)
  const mutate = descriptorOf(contributions, TARGET_METHODS[2].id)
  const describe = descriptorOf(contributions, TARGET_METHODS[0].id)
  const modelCatalog = descriptorOf(contributions, TARGET_METHODS[3].id)

  // 负对照：2 参写调用（修复前适配层形状）必被守卫拒绝——错误消息与 RCA
  // §3 实测一致（user 报障「保存失败」的真实抛点）
  for (const [name, descriptor, twoArgs] of [
    ['settings/update', update, ['llm-reasoning', { level: 'medium' }]],
    ['settings/mutate', mutate, ['llm-reasoning', [{ op: 'unset', path: ['models', 'demo/m1'] }]]],
  ]) {
    assert.throws(
      () => gatewayArityGuard(descriptor, twoArgs),
      (error) => {
        assert.match(error.message, new RegExp(`client api: @deepseek-ai/dsh-api-settings-controller#${name} expected 3 argument\\(s\\), got 2`))
        return true
      },
      `守卫必须拒绝 ${name} 的 2 参调用（负对照——证明本判别组对修复前缺陷是 RED 而非假绿）`,
    )
  }
  // 正对照：3 参含显式 undefined 必放行（F1 修复方向实证）
  gatewayArityGuard(update, ['llm-reasoning', { level: 'medium' }, undefined])
  gatewayArityGuard(mutate, ['llm-reasoning', [{ op: 'unset', path: ['models', 'demo/m1'] }], undefined])
  gatewayArityGuard(describe, [])
  gatewayArityGuard(modelCatalog, [])
})
