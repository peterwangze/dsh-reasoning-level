/**
 * Client render smoke — executes lib/client.js in a sandbox with a minimal
 * React stub and renders every component through its loaded-data path.
 *
 * This is the regression gate for render-time crashes (the v0.5.0
 * `ReferenceError: t is not defined` in StatsPanel shipped because nothing
 * ever executed the loaded-stats render path). It runs in CI and locally:
 *
 *   node scripts/client-smoke.mjs
 *
 * Exit 0 = every component rendered twice (loading + loaded) without
 * throwing. Any exception fails the process with the component name.
 *
 * @module dsh-reasoning-level/scripts/client-smoke
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

// ── minimal React stub: order-keyed hooks, one store per component ────────
// Components here render at most once per render() call, so hook state is
// keyed by (component, call order) and survives across renders like React
// state does — the second render after an effect resolves sees loaded data.
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
    const flat = (list) => list.flat(Infinity)
    return { $$: typeof tag === 'function' ? 'component' : String(tag), tag, props: props ?? {}, children: flat(children) }
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
    // Never run the disposer: the smoke renders each component twice as a
    // standing component (loading → loaded), not as mount → unmount. Calling
    // the cleanup immediately would flip every effect's `alive` flag and no
    // data would ever load.
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

const timers = []
const effectsRan = () => new Promise((resolve) => setTimeout(resolve, 5))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── host-side stubs the client touches during render ─────────────────────
const STATS_FIXTURE = {
  since: Date.now(),
  totalCalls: 2,
  models: {
    'demo/m1': {
      calls: 2, efforts: { high: 2 }, reasoningTokens: 12, outputTokens: 34,
      reasoningChars: 0, durationMs: 120, errors: 0, errRate: 0, rejected: [],
      // FEAT-005：per-level 聚合（同一模型两个等级桶）→ 等级对比区必须渲染对照表
      byLevel: {
        high: { calls: 1, reasoningTokens: 6, outputTokens: 12, reasoningChars: 0, durationMs: 60, errors: 0 },
        max: { calls: 1, reasoningTokens: 6, outputTokens: 22, reasoningChars: 0, durationMs: 60, errors: 0 },
      },
    },
  },
  recent: [
    { t: Date.now(), provider: 'demo', model: 'm1', effort: 'high', rt: 12, rc: null, ot: 34, it: 10, duration: 60, finish: 'stop' },
    // 028-F3：(默认) 记账复合标注——入口无显式等级（effort:null）+ 服务端推导的
    // 将物化路由默认（defaulted:'high'）→ 最近调用表必须渲染「默认→高」
    { t: Date.now(), provider: 'demo', model: 'm1', effort: null, defaulted: 'high', rt: 12, rc: null, ot: 34, it: 10, duration: 60, finish: 'stop' },
  ],
  blacklist: {},
  // 027-F3：持久化探测回显——StatsPanel 挂载轮询读到 lastProbe 后必须重建结果表
  lastProbe: {
    t: 1757100000000,
    models: {
      'demo/m1': { working: ['high', 'max'], rejected: ['xhigh'], blocked: [], persisted: 'no-change-already-correct' },
      // FEAT-004 ⑦（设计 §6.2/§10.1）：blocked 归因 + 官方适配器结局两列渲染源
      'demo/m2': {
        working: [], rejected: [], blocked: ['max'],
        blockedReasons: { max: { code: 'RATE_LIMITED', message: '429 too many requests' } },
        persisted: 'skipped:official-adapter',
      },
    },
  },
}

const API = {
  settings: {
    describe: async () => ({
      result: {
        ok: true,
        value: {
          namespaces: [
            // 028-F2 冒烟断言用：全局 level=max + 路由 reasoning=high（陈旧值）→
            // appliedSummary 必须值感知渲染「demo=高（≠全局最大）」而非存在性计数掩盖
            { ns: 'llm-reasoning', value: { enabled: true, level: 'max', models: {}, purposes: {}, syncDefaultAgent: false, statsPublic: false } },
            { ns: 'llm-pi-ai', value: { providers: { demo: { reasoning: 'high', models: [{ id: 'm1', reasoningEfforts: { high: 'high' } }] } } } },
            { ns: 'llm-deepseek', value: { reasoningEffort: 'max' } },
          ],
        },
      },
    }),
    update: async () => ({ result: { ok: true } }),
    mutate: async () => ({ result: { ok: true } }),
  },
  llm: {
    models: async () => ({
      result: {
        ok: true,
        value: { groups: [{ id: 'demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' } }] }] },
      },
    }),
  },
}
// UX-003 §7.1①：记录页内控件实际触发的写入，用于断言 7 个写入口全部仍在。
const writeCalls = []

// ── MAINT-022：宿主 0.1.2-rc.1 客户端形状——connection.api 已移除，统一经
// remote.settings / remote.session 命名空间（typed remote 直面 {ok,value|error}）。
// 适配层（hostApiFace）消费该形状并收敛为上面的旧信封 API；冒烟自此锚定新接缝。
// ── MAINT-025 (b)：桩升级为契约校验桩（RCA §8-b）——元数/形状违约即 fail(exit 1)。
// 桩形状锚定宿主描述符而非适配层假设：settings.describe / session.modelCatalog
// 零参；settings.update/mutate 三参（ns, patch/ops, expectedRevision——第三参必须
// 占位，值可 undefined = 无条件写入，dsh-api-settings-controller lib/index.js:443-472）；
// ops 元素 {op:'set',path:string[],value} | {op:'unset',path:string[]}（api-remotes
// lib/client.js:4759-4775）；网关严格元数守卫事实源 dsh-api-gateway lib/client.js:1626-1633。
// 旧「记录型 ok 桩」不校验元数 = 桩 ↔ 适配层循环自证（RCA 5-Why 第 3 层——本冒烟
// 曾全绿放过 2 参转发缺陷）。真实工件判别另见 test/host-face-contract.test.mjs。
const contractViolation = (message) => {
  console.error('smoke: host-face contract violation — ' + message)
  process.exit(1)
}

const assertWriteContract = (method, args, checkSecondArg) => {
  if (args.length !== 3) {
    contractViolation(`${method} expected 3 positional args (ns, patch/ops, expectedRevision — dsh-api-remotes 0.1.2-rc.1 descriptor; gateway arity guard dsh-api-gateway lib/client.js:1626-1633), got ${args.length}`)
  }
  if (typeof args[0] !== 'string' || args[0].length === 0) {
    contractViolation(`${method} ns must be a non-empty string, got ${JSON.stringify(args[0])}`)
  }
  checkSecondArg(args[1])
  if (!(args[2] === undefined || (Number.isInteger(args[2]) && args[2] >= 0))) {
    contractViolation(`${method} expectedRevision must be undefined or a non-negative integer, got ${JSON.stringify(args[2])}`)
  }
}

const HOST_FACES = {
  remoteSettings: {
    describe: async (...args) => {
      if (args.length !== 0) contractViolation(`settings.describe expected 0 args (read path — arity match is why rendering survived MAINT-025), got ${args.length}`)
      const response = await API.settings.describe()
      return { ok: response.result.ok, value: response.result.value }
    },
    update: async (...args) => {
      assertWriteContract('settings.update', args, (patch) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) contractViolation('settings.update patch must be a plain object, got ' + JSON.stringify(patch))
      })
      writeCalls.push({ method: 'update', ns: args[0], patch: args[1] })
      return { ok: true, value: { ns: args[0], value: args[1] } }
    },
    mutate: async (...args) => {
      assertWriteContract('settings.mutate', args, (ops) => {
        if (!Array.isArray(ops)) contractViolation('settings.mutate ops must be an array, got ' + JSON.stringify(ops))
        for (const op of ops) {
          const pathOk = op !== null && typeof op === 'object' && Array.isArray(op.path) && op.path.every((key) => typeof key === 'string')
          const isSet = pathOk && op.op === 'set' && 'value' in op
          const isUnset = pathOk && op.op === 'unset'
          if (!isSet && !isUnset) contractViolation(`settings.mutate ops element must be {op:"set",path:string[],value} | {op:"unset",path:string[]} (api-remotes:4759-4774), got ${JSON.stringify(op)}`)
        }
      })
      writeCalls.push({ method: 'mutate', ns: args[0], ops: args[1] })
      return { ok: true, value: { ns: args[0], value: {} } }
    },
  },
  remoteSession: {
    modelCatalog: async (...args) => {
      if (args.length !== 0) contractViolation(`session.modelCatalog expected 0 args, got ${args.length}`)
      const response = await API.llm.models()
      return { ok: response.result.ok, value: { groups: response.result.value.groups, failures: [] } }
    },
  },
}

// ── load the client module through its own ModuleLoader contract ─────────
let loaded = null
// R0-P3-7：CSV 导出的浏览器面桩（exportCsv 在沙箱里也能真实执行并捕获产物）。
const csvSink = { value: '' }
class CsvBlob {
  constructor(parts) { this.parts = Array.isArray(parts) ? parts : [] }
}
const sandbox = {
  window: {
    __ModuleLoader__: { load(def) { loaded = def } },
    setInterval: () => 0,
    clearInterval: () => {},
    // 客户端在浏览器路径上使用 window.setTimeout/clearTimeout（toast 自动消失、
    // probe 抓取超时）。冒烟不依赖真实计时，直接返回 0（不建定时器、不自动消失）。
    setTimeout: () => 0,
    clearTimeout: () => {},
  },
  // probeAll 直接调用 AbortController（VM 新上下文无 Node 全局）
  AbortController,
  Blob: CsvBlob,
  URL: {
    createObjectURL: (blob) => {
      csvSink.value = Array.isArray(blob.parts) ? blob.parts.join('') : ''
      return 'blob:smoke'
    },
    revokeObjectURL: () => {},
  },
  document: {
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, click() {} }),
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => STATS_FIXTURE }),
}
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
if (loaded === null || loaded.id !== 'dsh-reasoning-level') {
  console.error('smoke: window.__ModuleLoader__ did not capture the client module')
  process.exit(1)
}
const client = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error('client required unexpected module: ' + name)
})

// ── 1. apply(ctx) registers exactly one settings section ─────────────────
const registered = []
const slotsApi = {
  inject: (_slot, provider) => provider(),
  register: (meta, render) => {
    registered.push({ meta, render })
    return () => {}
  },
}
const ctx = {
  // MAINT-022：新宿主形状——remote.settings/remote.session（connection.api 已移除）
  get: (name) => (name === 'remote.settings' ? HOST_FACES.remoteSettings
    : name === 'remote.session' ? HOST_FACES.remoteSession
    : name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
  slots: slotsApi,
}
client.apply(ctx)
if (registered.length !== 1 || registered[0].meta.name !== 'settings.section') {
  console.error('smoke: apply() registered ' + registered.length + ' sections, expected exactly one settings.section')
  process.exit(1)
}
const pageElement = registered[0].render({})
if (pageElement.$$ !== 'component' || typeof pageElement.tag !== 'function') {
  console.error('smoke: section render did not produce a ReasoningPage component element')
  process.exit(1)
}
if (pageElement.props.api === undefined || pageElement.props.api.settings === undefined) {
  console.error('smoke: section element must carry the hostApiFace api (MAINT-022)')
  process.exit(1)
}

// ── 2. render every component through loading AND loaded paths ───────────
// （MAINT-022：页面 props 携带适配层 api——冒烟走真实接缝而非旁路旧信封）
const components = [
  ['ReasoningPage', pageElement.tag, pageElement.props],
]
const factoryExports = client
// The factory only exposes apply/inject on module.exports; components are
// reachable through the section element graph — walk it to collect them.
function collectComponents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && typeof node.tag === 'function' && node.tag.name && !into.some(([n]) => n === node.tag.name)) {
    into.push([node.tag.name, node.tag, node.props])
  }
  for (const child of node.children ?? []) collectComponents(child, into)
  collectComponents(node.props?.children, into)
}

async function renderTwice(name, fn, props) {
  resetHooks(name)
  fn(props)
  await effectsRan()
  resetHooks(name)
  const tree = fn(props)
  await effectsRan()
  return tree
}

// First pass over the page: collects ModelDefaults / PurposeDefaults /
// StatsPanel component elements nested in the loaded ReasoningPage render.
const pageTree = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
collectComponents(pageTree, components)

// ── 2b. 028-F2：appliedSummary 值感知——路由当前值 ≠ 全局目标时如实警示 ─────
// （fixture：全局 level=max + demo 路由 reasoning=high → 必须渲染「demo=高」
//  与「≠全局最大」失配标注；存在性计数（已应用 1 个路由）= 回归即失败）
function collectText(node, into) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { into.push(String(node)); return }
  if (typeof node !== 'object') return
  for (const child of node.children ?? []) collectText(child, into)
}
const pageText = []
collectText(pageTree, pageText)
const pageTextAll = pageText.join('|')
if (!pageTextAll.includes('demo=高') || !pageTextAll.includes('≠全局最大')) {
  console.error('smoke: appliedSummary must render route values and warn on mismatch vs global level (028-F2)')
  process.exit(1)
}

let rendered = 0
let statsPanelTree = null
// UX-003：stats/catalog 由页面拥有，页面树里收集到的 StatsPanel/ModelDefaults props
// 已是 loaded 快照；这里补一次显式 loading 渲染，保留「每个组件都走过 loading 态」
// 的原冒烟语义（stats===null / models===null 分支仍可能崩）。
function loadingProps(name, props) {
  if (name === 'StatsPanel') return { ...props, stats: null, statsFailed: false }
  if (name === 'ModelDefaults') return { ...props, models: null }
  return props
}
for (const [name, fn, props] of components) {
  if (typeof fn !== 'function') continue
  const resolvedProps = props ?? pageElement.props
  if (name === 'StatsPanel' || name === 'ModelDefaults') {
    resetHooks(name)
    fn(loadingProps(name, resolvedProps))
    await effectsRan()
  }
  const tree = await renderTwice(name, fn, resolvedProps)
  if (name === 'StatsPanel') statsPanelTree = tree
  rendered += 1
}
if (rendered < 3) {
  console.error('smoke: expected to exercise at least 3 components (page, defaults, stats), rendered ' + rendered)
  process.exit(1)
}

// ── 2c. 027-F3/F4：StatsPanel 挂载从持久化 lastProbe 重建结果表 + 持久化列 ──
// （fixture lastProbe 携带 demo/m1 {working:[high,max], persisted:no-change-…}；
//  回显表必须出现该模型词条与「持久化」列结局文案；「从未探测」空态必须不出现）
if (statsPanelTree === null) {
  console.error('smoke: StatsPanel component was not exercised — cannot assert lastProbe restore (027-F3)')
  process.exit(1)
}
const statsText = []
collectText(statsPanelTree, statsText)
const statsTextAll = statsText.join('|')
if (!statsTextAll.includes('demo/m1') || !statsTextAll.includes('持久化') || !statsTextAll.includes('已与实测一致')) {
  console.error('smoke: StatsPanel must rebuild probe results from persisted lastProbe with persisted-outcome column (027-F3/F4)')
  process.exit(1)
}
if (statsTextAll.includes('尚未探测过')) {
  console.error('smoke: never-probed empty state must NOT render when lastProbe has models (027-F3)')
  process.exit(1)
}

// ── 2c-2 FEAT-004 ⑦：探测结果「其他错误」列归因 + 官方适配器结局渲染 ─────────
// （fixture demo/m2：blocked=['max'] + blockedReasons.max=429 → 「限流或额度不足」；
//  persisted=skipped:official-adapter → PERSISTED_KEYS 新语义文案，不得显示旧
//  「不在 llm-pi-ai 配置」）
if (!statsTextAll.includes('限流或额度不足') || !statsTextAll.includes('由 DeepSeek 官方适配器管理')) {
  console.error('smoke: probe results must render blocked attribution and official-adapter outcome (FEAT-004 ⑦) — got ' + statsTextAll)
  process.exit(1)
}
if (statsTextAll.includes('不在 llm-pi-ai 配置——仅展示')) {
  console.error('smoke: official-adapter result must not fall back to the misleading "not in llm-pi-ai config" text (FEAT-004 ⑦)')
  process.exit(1)
}

// ── 2c-3 FEAT-005：等级对比区（byLevel loaded 路径）────────────────────────────
// StatsPanel 内的 LevelCompare 是惰性组件元素，collectText 不会下钻它的渲染树；
// 从已渲染的 StatsPanel 树里收集组件并单独渲染，断言对照表真实出现在 DOM 树里。
const statsComponents = []
collectComponents(statsPanelTree, statsComponents)
const levelCompareEntry = statsComponents.find(([name]) => name === 'LevelCompare')
if (levelCompareEntry === undefined) {
  console.error('smoke: LevelCompare component is missing from the loaded StatsPanel tree (FEAT-005)')
  process.exit(1)
}
const levelCompareTree = await renderTwice('LevelCompare', levelCompareEntry[1], levelCompareEntry[2])
// LevelCompare 返回 Disclosure 元素（组件）——再渲染一层，让 <summary> 标题与表体
// 都进入可遍历的节点树（Disclosure 无 hook；children 以第三参传入，需显式回填）。
const renderedCompare = levelCompareTree.$$ === 'component'
  ? levelCompareTree.tag({ ...levelCompareTree.props, children: levelCompareTree.children })
  : levelCompareTree
const compareText = []
collectText(renderedCompare, compareText)
const compareTextAll = compareText.join('|')
if (!compareTextAll.includes('等级对比（同一模型不同等级的实际代价）')
  || !compareTextAll.includes('demo/m1') || !compareTextAll.includes('高') || !compareTextAll.includes('最大')
  || !compareTextAll.includes('平均耗时')) {
  console.error('smoke: level comparison must render a per-level comparison table for a 2-bucket model (FEAT-005) — got ' + compareTextAll)
  process.exit(1)
}
if (compareTextAll.includes('等级对比数据自 v0.9.0 起累积')) {
  console.error('smoke: level comparison must NOT render the upgrade empty state when byLevel has ≥2 buckets (FEAT-005)')
  process.exit(1)
}
// 旧服务端（无 byLevel）→ 空态必须如实说明「数据自 v0.9.0 起累积」（设计 §10.4）
const legacyStats = { ...STATS_FIXTURE, models: { 'demo/m1': { ...STATS_FIXTURE.models['demo/m1'], byLevel: undefined } } }
const legacyCompareTree = await renderTwice('LevelCompare', levelCompareEntry[1], { ...levelCompareEntry[2], stats: legacyStats })
const renderedLegacyCompare = legacyCompareTree.$$ === 'component'
  ? legacyCompareTree.tag({ ...legacyCompareTree.props, children: legacyCompareTree.children })
  : legacyCompareTree
const legacyCompareText = []
collectText(renderedLegacyCompare, legacyCompareText)
if (!legacyCompareText.join('|').includes('等级对比数据自 v0.9.0 起累积')) {
  console.error('smoke: level comparison must show the v0.9.0 accumulation empty state when byLevel is absent (FEAT-005 / §10.4)')
  process.exit(1)
}

// ── 2d. 028-F3：(默认) 记账复合标注 + statsHint 措辞如实化 ──────────────────
// （fixture recent 含 effort:null + defaulted:'high' → 最近调用表必须渲染复合
//  标签「默认→高」；说明区 statsHint 不得再出现与实现不符的旧措辞「默认物化后的
//  最终值」——物化实际发生在插件 hook 之后的 adapter 内部，RCA §3.4）
if (!statsTextAll.includes('默认→高')) {
  console.error('smoke: recent-calls effort column must render compound label 默认→高 for defaulted records (028-F3)')
  process.exit(1)
}
if (pageTextAll.includes('默认物化后的最终值')) {
  console.error('smoke: statsHint must not claim "默认物化后的最终值" — materialization happens after the plugin hook (028-F3, RCA §3.4)')
  process.exit(1)
}

// ── 2e. UX-003 §7.1①：7 个写入口全部保留（结构遍历 → 实际触发页面 change）────
// （enabled / level / syncDefaultAgent / models 增改 / 删除 / purposes.compaction /
//  purposes.session-title；调用形状仍经适配层三参桩校验）
// collectComponents 按组件名去重（供逐组件渲染）；写入口断言需要收集同名基元的
// 全部实例（如两个 Switch），故单独遍历。
const switchEntries = []
;(function collectSwitches(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && node.tag?.name === 'Switch') switchEntries.push(node.props)
  for (const child of node.children ?? []) collectSwitches(child)
  collectSwitches(node.props?.children)
})(pageTree)
const segmentedEntry = components.find(([name]) => name === 'SegmentedControl')
const modelDefaultsEntry = components.find(([name]) => name === 'ModelDefaults')
const purposeDefaultsEntry = components.find(([name]) => name === 'PurposeDefaults')
const enableCtl = switchEntries.find((props) => props.label === '启用统一默认推理等级')
const syncCtl = switchEntries.find((props) => props.label === '同步默认 agent 模型等级')
if (enableCtl === undefined || syncCtl === undefined || segmentedEntry === undefined
  || modelDefaultsEntry === undefined || purposeDefaultsEntry === undefined) {
  console.error('smoke: UX-003 write-entry controls missing (enabled/level/sync/models/purposes)')
  process.exit(1)
}
enableCtl.onChange(false)
segmentedEntry[2].onChange('xhigh')
syncCtl.onChange(true)
modelDefaultsEntry[2].onChange({ models: { 'demo/m1': 'max' } })
modelDefaultsEntry[2].onChange({ removeModelKey: 'demo/m1' })
purposeDefaultsEntry[2].onChange({ purposes: { compaction: 'off' } })
purposeDefaultsEntry[2].onChange({ purposes: { 'session-title': 'low' } })
await effectsRan()
const updatePatches = writeCalls.filter((call) => call.method === 'update').map((call) => call.patch)
const deleteCall = writeCalls.find((call) => call.method === 'mutate')
const writeEntryOk = updatePatches.some((patch) => patch.enabled === false)
  && updatePatches.some((patch) => patch.level === 'xhigh')
  && updatePatches.some((patch) => patch.syncDefaultAgent === true)
  && updatePatches.some((patch) => patch.models !== undefined && patch.models['demo/m1'] === 'max')
  && updatePatches.some((patch) => patch.purposes !== undefined && patch.purposes.compaction === 'off')
  && updatePatches.some((patch) => patch.purposes !== undefined && patch.purposes['session-title'] === 'low')
  && deleteCall !== undefined
  && JSON.stringify(deleteCall.ops) === JSON.stringify([{ op: 'unset', path: ['models', 'demo/m1'] }])
if (!writeEntryOk) {
  console.error('smoke: UX-003 7 write entries must still route to settings.update/mutate — got ' + JSON.stringify(writeCalls))
  process.exit(1)
}

// ── 2f. FEAT-004 §3.4.1：模型级默认改为可搜索添加（点击候选 → models 深合并）────
// （长 <select> 移除后，「catalog 模型可被添加」的语义载体 = 候选行 data-model-key；
//  点击即写入最高支持档 max，调用形状仍是 update({ns, patch})）
const mdLoadedTree = await renderTwice('ModelDefaults', modelDefaultsEntry[1], {
  ...modelDefaultsEntry[2],
  lastProbe: STATS_FIXTURE.lastProbe,
})
const searchCandidates = []
;(function collectCandidates(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.props?.['data-model-key'] === 'string' && typeof node.props?.onClick === 'function') searchCandidates.push(node)
  for (const child of node.children ?? []) collectCandidates(child)
  collectCandidates(node.props?.children)
})(mdLoadedTree)
const addCandidate = searchCandidates.find((node) => node.props['data-model-key'] === 'demo/m1')
if (addCandidate === undefined) {
  console.error('smoke: model search must list catalog candidates (demo/m1) for click-to-add (FEAT-004 §3.4.1)')
  process.exit(1)
}
const writesBeforeAdd = writeCalls.length
addCandidate.props.onClick()
await effectsRan()
const addPatch = writeCalls.slice(writesBeforeAdd).map((call) => call.patch)
  .find((patch) => patch !== undefined && patch.models !== undefined && patch.models['demo/m1'] === 'max')
if (addPatch === undefined) {
  console.error('smoke: clicking a search candidate must write models[key] = highest supported level (max) via settings.update — got ' + JSON.stringify(writeCalls.slice(writesBeforeAdd)))
  process.exit(1)
}

// ── 2f-2. FEAT-004 §3.4.3：支持矩阵（折叠标题覆盖率 + ✓/✗/? + 来源 title）─────────
const mdComponents = []
collectComponents(mdLoadedTree, mdComponents)
const matrixEntry = mdComponents.find(([name]) => name === 'SupportMatrix')
if (matrixEntry === undefined) {
  console.error('smoke: SupportMatrix component must render inside the model defaults card (FEAT-004 §3.4.3)')
  process.exit(1)
}
const matrixDisclosure = matrixEntry[1](matrixEntry[2])
const matrixTree = matrixDisclosure.$$ === 'component'
  ? matrixDisclosure.tag({ ...matrixDisclosure.props, children: matrixDisclosure.children })
  : matrixDisclosure
const flattenText = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(flattenText).join('')
}
if (!flattenText(matrixTree).includes('覆盖率 1/1 已探测')) {
  console.error('smoke: support matrix summary must show coverage (probed/total) — got ' + flattenText(matrixTree))
  process.exit(1)
}
const matrixCells = []
;(function collectMatrixCells(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.props?.className === 'string' && /rl-matrix-(yes|no|unknown)/.test(node.props.className)) matrixCells.push(node)
  for (const child of node.children ?? []) collectMatrixCells(child)
  collectMatrixCells(node.props?.children)
})(matrixTree)
const cellCount = (state) => matrixCells.filter((node) => node.props.className.includes('rl-matrix-' + state)).length
// fixture：demo/m1 实测 working=[high,max] + rejected=[xhigh] → ✓×2 / ✗×1 / ?×4
if (cellCount('yes') !== 2 || cellCount('no') !== 1 || cellCount('unknown') !== 4) {
  console.error('smoke: support matrix must render measured ✓/✗ and unknown ? cells — got yes=' + cellCount('yes') + ' no=' + cellCount('no') + ' unknown=' + cellCount('unknown'))
  process.exit(1)
}
if (!matrixCells.some((node) => node.props.title === '实测') || !matrixCells.some((node) => node.props.title === '实测拒绝')) {
  console.error('smoke: support matrix cells must explain their source in title (实测 / 实测拒绝)')
  process.exit(1)
}

// ── 2g. FEAT-004 §5.1/§10.3：成功写入 → 「已保存 + 撤销」→ 撤销 = 反向写 ─────────
const afterAddPage = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const afterAddComponents = []
collectComponents(afterAddPage, afterAddComponents)
const toastEntry = afterAddComponents.find(([name]) => name === 'Toast')
if (toastEntry === undefined || toastEntry[2].actionLabel !== '撤销'
  || !String(toastEntry[2].message).includes('已保存')) {
  console.error('smoke: successful write must show a 「已保存」toast with 「撤销」action (FEAT-004 §5.1)')
  process.exit(1)
}
const writesBeforeUndo = writeCalls.length
toastEntry[2].onAction()
await effectsRan()
const undoUnset = writeCalls.slice(writesBeforeUndo).find((call) => call.method === 'mutate'
  && JSON.stringify(call.ops) === JSON.stringify([{ op: 'unset', path: ['models', 'demo/m1'] }]))
if (undoUnset === undefined) {
  console.error('smoke: undo of an added model default must reverse-write via mutate unset [models, key] — got ' + JSON.stringify(writeCalls.slice(writesBeforeUndo)))
  process.exit(1)
}

// ── 2h. FEAT-004 §3.6.1/§5.3：统计工具栏（暂停/只看异常/排序）+ persisted 三态 ───
const statsEntry = components.find(([name]) => name === 'StatsPanel')
if (statsEntry === undefined) {
  console.error('smoke: StatsPanel component must be reachable for toolbar assertions (FEAT-004 §3.6.1)')
  process.exit(1)
}
const renderStats = (props) => {
  resetHooks('StatsPanel')
  return statsEntry[1](props)
}
const collectButtons = (tree) => {
  const out = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.$$ === 'component' && node.tag?.name === 'Button' && typeof node.props?.onClick === 'function') out.push(node)
    for (const child of node.children ?? []) walk(child)
    walk(node.props?.children)
  })(tree)
  return out
}
const collectHeaders = (tree) => {
  const out = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.$$ === 'th') out.push(node)
    for (const child of node.children ?? []) walk(child)
    walk(node.props?.children)
  })(tree)
  return out
}
const statsTree = renderStats(statsEntry[2])
const pauseButton = collectButtons(statsTree).find((node) => flattenText(node) === '暂停刷新')
const issueButton = collectButtons(statsTree).find((node) => flattenText(node) === '只看异常')
if (pauseButton === undefined || issueButton === undefined
  || pauseButton.props['aria-pressed'] !== false || issueButton.props['aria-pressed'] !== false) {
  console.error('smoke: stats toolbar must expose 暂停刷新/只看异常 with aria-pressed=false initially (FEAT-004 §3.6.1)')
  process.exit(1)
}
// Toolbar 是组件元素（meta 在 props 里），未渲染树不产生文本节点——按 props 断言
const toolbarMetas = []
;(function collectToolbarMeta(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && node.tag?.name === 'Toolbar' && typeof node.props?.meta === 'string') toolbarMetas.push(node.props.meta)
  for (const child of node.children ?? []) collectToolbarMeta(child)
  collectToolbarMeta(node.props?.children)
})(statsTree)
if (!toolbarMetas.some((meta) => meta.includes('每 2s 刷新 · 最近 100 条'))) {
  console.error('smoke: stats toolbar must show refresh cadence meta (每 2s 刷新 · 最近 100 条) — got ' + JSON.stringify(toolbarMetas))
  process.exit(1)
}
const sortHeaders = collectHeaders(statsTree).filter((node) => node.props['aria-sort'] !== undefined)
const callsHeader = sortHeaders.find((node) => flattenText(node).includes('调用'))
if (callsHeader === undefined || callsHeader.props['aria-sort'] !== 'descending') {
  console.error('smoke: model aggregate table must default-sort by calls descending with aria-sort (FEAT-004 §3.6.3)')
  process.exit(1)
}
const thinkHeader = sortHeaders.find((node) => flattenText(node).includes('思考'))
const thinkSortButton = (thinkHeader.children ?? []).find((child) => child.$$ === 'button')
thinkSortButton.props.onClick()
const sortedTree = renderStats(statsEntry[2])
const sortedHeaders = collectHeaders(sortedTree).filter((node) => node.props['aria-sort'] !== undefined)
const sortedThink = sortedHeaders.find((node) => flattenText(node).includes('思考'))
const sortedCalls = sortedHeaders.find((node) => flattenText(node).includes('调用'))
if (sortedThink === undefined || sortedThink.props['aria-sort'] !== 'descending'
  || sortedCalls === undefined || sortedCalls.props['aria-sort'] !== 'none') {
  console.error('smoke: clicking a sortable column header must move aria-sort (thinking descending, calls none) (FEAT-004 §3.6.3)')
  process.exit(1)
}
const issueButtonNow = collectButtons(sortedTree).find((node) => flattenText(node) === '只看异常')
issueButtonNow.props.onClick()
const filteredTree = renderStats(statsEntry[2])
if (!flattenText(filteredTree).includes('没有异常调用')) {
  console.error('smoke: 「只看异常」must filter rows with errors===0 and no suggestion (FEAT-004 §3.6.1)')
  process.exit(1)
}
const pauseButtonNow = collectButtons(filteredTree).find((node) => flattenText(node) === '暂停刷新')
pauseButtonNow.props.onClick()
const pausedPage = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const pausedComponents = []
collectComponents(pausedPage, pausedComponents)
const pausedStats = pausedComponents.find(([name]) => name === 'StatsPanel')
if (pausedStats === undefined || pausedStats[2].paused !== true) {
  console.error('smoke: 暂停刷新 must flip the page polling state passed to StatsPanel (FEAT-004 §3.6.1)')
  process.exit(1)
}
const pausedTree = renderStats(pausedStats[2])
if (!collectButtons(pausedTree).some((node) => flattenText(node) === '继续刷新' && node.props['aria-pressed'] === true)) {
  console.error('smoke: paused toolbar must render 继续刷新 with aria-pressed=true')
  process.exit(1)
}
const pausedText = flattenText(pausedTree)
if (!pausedText.includes('最近调用') || !pausedText.includes('默认→高')) {
  console.error('smoke: pausing stats refresh must NOT stop rendering the recent-calls table (FEAT-004 §3.6.1)')
  process.exit(1)
}
// persisted 三态（§10.1）：provider 在 pi-ai 配置里 = 让用户去添加该模型；不在 = 其他适配器提供
const copyProbe = {
  targets: [], probing: false, progress: '', summary: '', summaryOk: true,
  results: [
    { key: 'demo/m3', provider: 'demo', working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
    { key: 'vendor/x1', provider: 'vendor', working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
  ],
}
const copyStats = { since: Date.now(), totalCalls: 0, models: {}, recent: [], blacklist: {}, lastProbe: { t: 1, models: {} } }
const copyText = flattenText(renderStats({ ...pausedStats[2], stats: copyStats, probe: copyProbe, piAiProviders: ['demo'] }))
if (!copyText.includes('在 llm-pi-ai 的 demo 下没有这个模型')
  || !copyText.includes('该模型由其他适配器提供')) {
  console.error('smoke: skipped:not-in-pi-ai-config must split into configured-provider vs other-adapter copy (FEAT-004 §10.1) — got ' + copyText)
  process.exit(1)
}
if (copyText.includes('仅展示，未写入')) {
  console.error('smoke: the misleading "仅展示，未写入" copy must not be used for skipped:not-in-pi-ai-config (FEAT-004 §10.1)')
  process.exit(1)
}
// ── 2i. R0-P2-3：撤销「删除模型默认」只写回该键 + 撤销时刻的最新 models ─────────
// 设计 §10.3：删除模型默认（mutate unset）的撤销 = update 写回旧等级（不是对称 unset）。
// R0-P2-3 判别：点击删除时的快照含 {demo/m1:low, demo/m2:high}；删除后（外部写者同时
// 删掉 demo/m2）刷新得到 {}。撤销必须只写回 demo/m1，**不得**把旧快照里的 demo/m2
// 一并回写（旧实现会静默复活它——本断言在旧实现下必红）。
const liveModels = { 'demo/m1': 'low', 'demo/m2': 'high' }
API.settings.describe = async () => ({
  result: {
    ok: true,
    value: {
      namespaces: [
        { ns: 'llm-reasoning', value: { enabled: true, level: 'max', models: { ...liveModels }, purposes: {}, syncDefaultAgent: false, statsPublic: false } },
        { ns: 'llm-pi-ai', value: { providers: { demo: { reasoning: 'high', models: [{ id: 'm1', reasoningEfforts: { low: 'low', high: 'high' } }, { id: 'm2' }] } } } },
        { ns: 'llm-deepseek', value: { reasoningEffort: 'max' } },
      ],
    },
  },
})
// live store 包装：原始契约桩先记录 writeCalls；随后把写入反映到 liveModels，
// 并模拟「外部写者在删除与刷新之间删掉了另一个模型」。
const rawRemoteUpdate = HOST_FACES.remoteSettings.update
const rawRemoteMutate = HOST_FACES.remoteSettings.mutate
HOST_FACES.remoteSettings.update = async (...args) => {
  const response = await rawRemoteUpdate(...args)
  const patch = args[1]
  if (patch !== null && typeof patch === 'object' && patch.models !== null && typeof patch.models === 'object') {
    Object.assign(liveModels, patch.models)
  }
  return response
}
HOST_FACES.remoteSettings.mutate = async (...args) => {
  const response = await rawRemoteMutate(...args)
  if (args[0] === 'llm-reasoning') {
    for (const op of Array.isArray(args[1]) ? args[1] : []) {
      if (op !== null && typeof op === 'object' && op.op === 'unset' && Array.isArray(op.path) && op.path.length === 2 && op.path[0] === 'models') delete liveModels[op.path[1]]
    }
    // 外部写者（另一标签页）在删除之后、刷新之前删除了 demo/m2
    delete liveModels['demo/m2']
  }
  return response
}
const deletePage = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const deletePageComponents = []
collectComponents(deletePage, deletePageComponents)
const deleteModelDefaults = deletePageComponents.find(([name]) => name === 'ModelDefaults')
if (deleteModelDefaults === undefined) {
  console.error('smoke: ModelDefaults must be reachable for delete-undo assertion (FEAT-004 §10.3)')
  process.exit(1)
}
const writesBeforeDelete = writeCalls.length
deleteModelDefaults[2].onChange({ removeModelKey: 'demo/m1' })
await effectsRan()
await sleep(20)
const afterDeletePage = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const afterDeleteComponents = []
collectComponents(afterDeletePage, afterDeleteComponents)
const deleteToast = afterDeleteComponents.find(([name]) => name === 'Toast')
if (deleteToast === undefined || deleteToast[2].actionLabel !== '撤销') {
  console.error('smoke: delete-model-default must offer the same 「撤销」action (FEAT-004 §10.3)')
  process.exit(1)
}
const writesBeforeDeleteUndo = writeCalls.length
deleteToast[2].onAction()
await effectsRan()
const restoreDelete = writeCalls.slice(writesBeforeDeleteUndo)
  .find((call) => call.method === 'update' && call.patch !== undefined && call.patch.models !== undefined && call.patch.models['demo/m1'] === 'low')
if (restoreDelete === undefined) {
  console.error('smoke: undo of a deleted model default must write the old level back via settings.update — got ' + JSON.stringify(writeCalls.slice(writesBeforeDeleteUndo)))
  process.exit(1)
}
if (Object.prototype.hasOwnProperty.call(restoreDelete.patch.models, 'demo/m2')) {
  console.error('smoke: undo of a deleted model default must NOT write back the stale models snapshot (demo/m2 resurrected) — R0-P2-3; got ' + JSON.stringify(restoreDelete.patch.models))
  process.exit(1)
}
const restoredKeys = Object.keys(restoreDelete.patch.models)
if (restoredKeys.length !== 1 || restoredKeys[0] !== 'demo/m1') {
  console.error('smoke: undo must restore exactly the deleted key {demo/m1: low} at undo time — R0-P2-3; got ' + JSON.stringify(restoreDelete.patch.models))
  process.exit(1)
}
const deleteCallBefore = writeCalls.slice(writesBeforeDelete, writesBeforeDeleteUndo)
  .find((call) => call.method === 'mutate')
if (deleteCallBefore === undefined || JSON.stringify(deleteCallBefore.ops) !== JSON.stringify([{ op: 'unset', path: ['models', 'demo/m1'] }])) {
  console.error('smoke: delete model default must keep the mutate unset call shape before undo — got ' + JSON.stringify(writeCalls.slice(writesBeforeDelete, writesBeforeDeleteUndo)))
  process.exit(1)
}

// ══ R0 返工的针对性断言（2026-10-20）════════════════════════════════════════
// R0-P2-6：agent-default 同步文案必须如实描述实际行为（实现没有还原路径，
// 旧「已还原 / 保持宿主原设置」承诺不得回归）。
for (const staleCopy of ['本插件写入的配置已还原', '关闭后保持宿主原设置', 'off keeps the host setting', 'Config written by this plugin has been reverted']) {
  if (source.includes(staleCopy)) {
    console.error('smoke: agent-default sync copy must describe actual behaviour (no revert path) — stale copy found: ' + staleCopy + ' (R0-P2-6)')
    process.exit(1)
  }
}
if (!source.includes('关闭后不再同步，已写入的值保持不变') || !source.includes('the default agent model is not reverted automatically')) {
  console.error('smoke: agent-default sync copy must state the real write/keep semantics in both languages (R0-P2-6)')
  process.exit(1)
}
const findComponent = (tree, name) => {
  const list = []
  collectComponents(tree, list)
  return list.find(([componentName]) => componentName === name)
}
const renderPageStats = async () => {
  const tree = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
  const stats = findComponent(tree, 'StatsPanel')
  if (stats === undefined) {
    console.error('smoke: StatsPanel must be reachable from the page tree (R0 assertions)')
    process.exit(1)
  }
  return { tree, stats }
}
const textOf = (node) => flattenText(node)

// ── 2j. R0-P2-1：probeDone 汇总行按「三态」分别计数 ──────────────────────────
// 服务端 /probe/apply 的 skipped 现在带可区分 reason：official-adapter /
// not-in-pi-ai-config / no-working-levels；汇总行必须各给一句准确文案，不得复用
// 旧「不在 llm-pi-ai 配置（结果仅展示，未写入）」归因。
API.llm.models = async () => ({
  result: {
    ok: true,
    value: { groups: [{ id: 'demo', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' }, { id: 'm4', name: 'M4' }] }] },
  },
})
// 计数必须彼此不同（2/1/1），否则「官方 ↔ 其他适配器」计数互换的变异无法被断言抓住。
const probeApplied = {
  writes: 0,
  outcomes: [],
  skipped: [
    { key: 'demo/m1', reason: 'official-adapter' },
    { key: 'demo/m2', reason: 'official-adapter' },
    { key: 'demo/m3', reason: 'not-in-pi-ai-config' },
    { key: 'demo/m4', reason: 'no-working-levels' },
  ],
}
sandbox.fetch = async (url, init) => {
  if (url === '/reasoning-level-stats/probe/apply') {
    return { ok: true, status: 200, json: async () => probeApplied }
  }
  if (url === '/reasoning-level-stats/probe') {
    let body = {}
    try { body = JSON.parse(init !== undefined && typeof init.body === 'string' ? init.body : '{}') } catch (error) { body = {} }
    return {
      ok: true,
      status: 200,
      json: async () => ({ provider: 'demo', model: body.model, key: 'demo/' + body.model, working: ['high'], rejected: [], blocked: [], persisted: 'pending-apply' }),
    }
  }
  return { ok: true, status: 200, json: async () => STATS_FIXTURE }
}
const probePage = await renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const probeHeader = findComponent(probePage, 'PageHeader')
if (probeHeader === undefined) {
  console.error('smoke: PageHeader must be reachable for probe summary assertion (R0-P2-1)')
  process.exit(1)
}
const probeButton = collectButtons(probeHeader[1](probeHeader[2]))
  .find((node) => flattenText(node) === '一键探测全部模型并固化配置')
if (probeButton === undefined) {
  console.error('smoke: probe-all button must be rendered in PageHeader (R0-P2-1)')
  process.exit(1)
}
probeButton.props.onClick()
await sleep(80)
const { stats: probeDoneStats } = await renderPageStats()
const probeSummaryText = textOf(probeDoneStats[1](probeDoneStats[2]))
for (const expected of [
  '2 个由官方适配器管理（无需写入）',
  '1 个由其他适配器提供（无需写入）',
  '1 个暂无可固化等级',
]) {
  if (!probeSummaryText.includes(expected)) {
    console.error('smoke: probeDone summary must count outcomes separately — missing "' + expected + '" in: ' + probeSummaryText)
    process.exit(1)
  }
}
if (probeSummaryText.includes('不在 llm-pi-ai 配置（结果仅展示，未写入）')) {
  console.error('smoke: probeDone summary must not reuse the old "不在 llm-pi-ai 配置" attribution (R0-P2-1)')
  process.exit(1)
}

// ── 2k. R0-P2-5：思考列 rt=rc=0 → title「该网关未回报 reasoning tokens」────────
stores.delete('StatsPanel')
const zeroThinkStats = {
  since: Date.now(), totalCalls: 1, recent: [], blacklist: {}, lastProbe: { t: 1, models: {} },
  models: {
    'demo/zero': {
      calls: 1, efforts: { high: 1 }, byLevel: {},
      reasoningTokens: 0, reasoningChars: 0, outputTokens: 5, durationMs: 10, errors: 0, errRate: 0, rejected: [],
    },
  },
}
const zeroThinkTree = renderStats({ ...statsEntry[2], stats: zeroThinkStats })
const titledCells = []
;(function collectTitledCells(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'td' && typeof node.props?.title === 'string') titledCells.push(node.props.title)
  for (const child of node.children ?? []) collectTitledCells(child)
  collectTitledCells(node.props?.children)
})(zeroThinkTree)
if (!titledCells.includes('该网关未回报 reasoning tokens')) {
  console.error('smoke: thinking column must explain rt=rc=0 as "gateway did not report reasoning tokens" (R0-P2-5) — got ' + JSON.stringify(titledCells))
  process.exit(1)
}

// ── 2l. R0-P3-6：LevelCompare 空态区分「非标准档位」与「数据自本版累积」────────
const nonStandardStats = {
  models: {
    'custom/m1': {
      calls: 3, efforts: { ultra: 3 }, byLevel: {},
      reasoningTokens: 1, outputTokens: 2, reasoningChars: 0, durationMs: 30, errors: 0, errRate: 0, rejected: [],
    },
  },
}
const nonStdDisclosure = levelCompareEntry[1]({ ...levelCompareEntry[2], stats: nonStandardStats })
const nonStdTree = nonStdDisclosure.$$ === 'component'
  ? nonStdDisclosure.tag({ ...nonStdDisclosure.props, children: nonStdDisclosure.children })
  : nonStdDisclosure
const nonStdText = textOf(nonStdTree)
if (!nonStdText.includes('非标准档位') || !nonStdText.includes('未计入等级对比')) {
  console.error('smoke: LevelCompare empty state must explain non-standard efforts buckets (R0-P3-6) — got ' + nonStdText)
  process.exit(1)
}
if (nonStdText.includes('等级对比数据自 v0.9.0 起累积')) {
  console.error('smoke: non-standard-only efforts must NOT fall back to the "accumulates from v0.9.0" empty state (R0-P3-6)')
  process.exit(1)
}

// ── 2m. R0-P3-7：CSV 追加 per-level 列（既有列不破）+ 最近调用渲染 100 行 ──────
const csvStats = {
  since: Date.now(), totalCalls: 2, recent: [], blacklist: {}, lastProbe: { t: 1, models: {} },
  models: {
    'demo/m1': {
      calls: 2, efforts: { high: 1, max: 1 },
      byLevel: {
        high: { calls: 1, reasoningTokens: 6, outputTokens: 12, reasoningChars: 0, durationMs: 60, errors: 0 },
        max: { calls: 1, reasoningTokens: 6, outputTokens: 22, reasoningChars: 0, durationMs: 60, errors: 0 },
      },
      reasoningTokens: 12, reasoningChars: 0, outputTokens: 34, durationMs: 120, errors: 0, errRate: 0, rejected: [],
    },
  },
}
stores.delete('StatsPanel')
const csvTree = renderStats({ ...statsEntry[2], stats: csvStats })
const exportButton = collectButtons(csvTree).find((node) => flattenText(node) === '导出 CSV')
if (exportButton === undefined) {
  console.error('smoke: CSV export button must be rendered (R0-P3-7)')
  process.exit(1)
}
csvSink.value = ''
exportButton.props.onClick()
const parseCsvLine = (line) => line.slice(1, -1).split('","')
const csvLines = csvSink.value.split('\n')
const csvHeader = parseCsvLine(csvLines[0])
const existingHeader = ['模型', '调用', '等级分布', '思考tokens', '思考字符', '输出tokens', '平均耗时ms', '错误率%']
if (JSON.stringify(csvHeader.slice(0, existingHeader.length)) !== JSON.stringify(existingHeader)) {
  console.error('smoke: CSV export must keep the existing columns unchanged (R0-P3-7) — got ' + JSON.stringify(csvHeader.slice(0, existingHeader.length)))
  process.exit(1)
}
if (csvHeader.length !== existingHeader.length + 8) {
  console.error('smoke: CSV export must append per-level columns for 7 levels + (默认) (R0-P3-7) — got ' + JSON.stringify(csvHeader))
  process.exit(1)
}
for (const label of ['关闭 调用', '高 调用', '最大 调用', '(默认) 调用']) {
  if (!csvHeader.includes(label)) {
    console.error('smoke: CSV per-level column missing "' + label + '" (R0-P3-7) — got ' + JSON.stringify(csvHeader))
    process.exit(1)
  }
}
const csvRow = parseCsvLine(csvLines[1])
const csvIndex = (label) => csvHeader.indexOf(label)
if (csvRow[0] !== 'demo/m1' || csvRow[csvIndex('高 调用')] !== '1' || csvRow[csvIndex('最大 调用')] !== '1' || csvRow[csvIndex('关闭 调用')] !== '0') {
  console.error('smoke: CSV per-level calls must match byLevel buckets (R0-P3-7) — got ' + JSON.stringify(csvRow))
  process.exit(1)
}
// 最近调用：wire 窗口 100（服务端 recent.slice(0,100)）→ 表格渲染行数必须与工具栏
// 「最近 100 条」一致（此前只渲染 20 行）。
const manyRecent = Array.from({ length: 100 }, (_, index) => ({
  t: 1757100000000 + index, provider: 'demo', model: 'm1', effort: 'high',
  rt: 1, rc: null, ot: 1, it: 1, duration: 1, finish: 'stop',
}))
stores.delete('StatsPanel')
const recentTree = renderStats({ ...statsEntry[2], stats: { ...csvStats, recent: manyRecent } })
let recentRowCount = 0
;(function countRecentRows(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'tr' && Array.isArray(node.children) && node.children.length === 7
    && node.children.every((cell) => cell !== null && typeof cell === 'object' && cell.$$ === 'td')) recentRowCount += 1
  for (const child of node.children ?? []) countRecentRows(child)
  countRecentRows(node.props?.children)
})(recentTree)
if (recentRowCount !== 100) {
  console.error('smoke: recent-calls table must render the full 100-row wire window to match 「最近 100 条」 (R0-P3-7) — got ' + recentRowCount)
  process.exit(1)
}
if (!toolbarMetas.some((meta) => meta.includes('最近 100 条'))) {
  console.error('smoke: stats toolbar meta must stay aligned with the rendered recent window (100) (R0-P3-7)')
  process.exit(1)
}

// ── 2n. R0-P2-4：en 语境 —— (默认) 显示映射 + 结构化 suggestion + off 计费说明 ─
const enRegistered = []
client.apply({
  get: (name) => (name === 'remote.settings' ? HOST_FACES.remoteSettings
    : name === 'remote.session' ? HOST_FACES.remoteSession
    : name === 'locale' ? { getSnapshot: () => ({ active: 'en' }) } : undefined),
  slots: {
    inject: (_slot, provider) => provider(),
    register: (meta, render) => { enRegistered.push({ meta, render }); return () => {} },
  },
})
if (enRegistered.length !== 1) {
  console.error('smoke: en apply() must register exactly one settings.section')
  process.exit(1)
}
API.settings.describe = async () => ({
  result: {
    ok: true,
    value: {
      namespaces: [
        { ns: 'llm-reasoning', value: { enabled: true, level: 'off', models: {}, purposes: {}, syncDefaultAgent: false, statsPublic: false } },
        { ns: 'llm-pi-ai', value: { providers: {} } },
        { ns: 'llm-deepseek', value: { reasoningEffort: 'max' } },
      ],
    },
  },
})
const enStats = {
  since: Date.now(), totalCalls: 3, recent: [], blacklist: {}, lastProbe: { t: 1, models: {} },
  models: {
    'demo/m1': {
      calls: 2, efforts: { '(默认)': 1, high: 1 },
      byLevel: {
        '(默认)': { calls: 1, reasoningTokens: 2, outputTokens: 3, reasoningChars: 0, durationMs: 10, errors: 0 },
        high: { calls: 1, reasoningTokens: 2, outputTokens: 4, reasoningChars: 0, durationMs: 10, errors: 0 },
      },
      reasoningTokens: 4, reasoningChars: 0, outputTokens: 7, durationMs: 20, errors: 0, errRate: 0, rejected: [],
      suggestionKind: 'high-error-rate', suggestionParams: { errorRate: 33 }, suggestion: '错误率 33% 偏高，建议降低等级',
    },
    'demo/m2': {
      calls: 1, efforts: { xhigh: 1 }, byLevel: {},
      reasoningTokens: 1, outputTokens: 2, reasoningChars: 0, durationMs: 5, errors: 1, errRate: 17, rejected: ['max'],
      suggestionKind: 'rejected-levels', suggestionParams: { rejected: ['max'], highest: 'high' }, suggestion: '实测拒绝 max，建议用最高档 high',
    },
  },
}
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => enStats })
stores.clear()
const enElement = enRegistered[0].render({})
const enPageTag = enElement.tag
const enPageProps = enElement.props
const enPage = await renderTwice('ReasoningPage', enPageTag, enPageProps)
const enStatsEntry = findComponent(enPage, 'StatsPanel')
if (enStatsEntry === undefined) {
  console.error('smoke: en StatsPanel must be reachable (R0-P2-4)')
  process.exit(1)
}
resetHooks('StatsPanel')
const enStatsTree = enStatsEntry[1](enStatsEntry[2])
const enText = textOf(enStatsTree)
// effort 分布是 LevelChip 组件（label 在 props 里，不是文本节点）——单独收集。
const enChipLabels = []
;(function collectChips(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && node.tag?.name === 'LevelChip' && typeof node.props?.label === 'string') enChipLabels.push(node.props.label)
  for (const child of node.children ?? []) collectChips(child)
  collectChips(node.props?.children)
})(enStatsTree)
if (!enChipLabels.includes('(default)×1')) {
  console.error('smoke: en context must render the (默认) bucket as "(default)" (R0-P2-4) — got ' + JSON.stringify(enChipLabels))
  process.exit(1)
}
if (enChipLabels.some((label) => label.includes('(默认)'))) {
  console.error('smoke: en context must not leak the Chinese (默认) bucket label (R0-P2-4) — got ' + JSON.stringify(enChipLabels))
  process.exit(1)
}
if (!enText.includes('Error rate 33% high, consider lowering level')) {
  console.error('smoke: structured suggestionKind must render in English (R0-P2-4) — got ' + enText)
  process.exit(1)
}
if (!enText.includes('Rejected Max in practice, use highest High')) {
  console.error('smoke: rejected-levels suggestion must render in English with level labels (R0-P2-4) — got ' + enText)
  process.exit(1)
}
if (enText.includes('错误率')) {
  console.error('smoke: en context must not render the legacy Chinese suggestion string when structured fields exist (R0-P2-4)')
  process.exit(1)
}
if (!textOf(enPage).includes('may still bill thinking')) {
  console.error('smoke: off level must explain gateway billing caveat visibly (R0-P2-5)')
  process.exit(1)
}

// ── 3. MAINT-025 (b)：写路径经真实适配层驱动契约桩。旧冒烟从不触发写路径，
// 契约桩不承重 = 防护形同虚设；此步让 update/mutate 的元数/形状校验真实执行
// （调用形状 = 页面 change() 的实际形状，锚定 lib/client.js:766-772——页面不传
// expectedRevision，由适配层按三参契约补位）。
await pageElement.props.api.settings.update({ ns: 'llm-reasoning', patch: { level: 'high' } })
await pageElement.props.api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', 'demo/m1'] }] })

for (const timer of timers) clearTimeout(timer)
console.log('client-smoke: OK — ' + rendered + ' components rendered through loading and loaded paths, 1 settings section registered, 7 write entries + 3-arg update/mutate contract stubs exercised, FEAT-004 (search add / support matrix / stats toolbar / undo / persisted tri-state) + blocked attribution + FEAT-005 level comparison + R0 fixes (probe summary tri-state counts / single-key delete undo / thinking-unreported title / non-standard level compare / CSV per-level columns / recent 100-row window / en (default)+structured suggestion / off billing note) asserted')
