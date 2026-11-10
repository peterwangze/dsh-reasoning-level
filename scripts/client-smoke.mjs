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
// T-F3：真实容器宽度回归。仅当用例设置非 0 值时，把 host 元素的 ref 桩成带
// getBoundingClientRect 的节点（模拟浏览器已布局的 DOM），让组件自己的
// ResizeObserver/挂载测量路径跑起来，而不是手写窄布局标记。
let measuredRefWidth = 0

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
    const normalized = props ?? {}
    if (measuredRefWidth > 0 && normalized.ref !== null && typeof normalized.ref === 'object') {
      normalized.ref.current = { getBoundingClientRect: () => ({ width: measuredRefWidth, height: 800 }) }
    }
    return { $$: typeof tag === 'function' ? 'component' : String(tag), tag, props: normalized, children: flat(children) }
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
    // UX-004：Esc 关闭详情依赖 document keydown 监听；冒烟记录 handler 直接派发。
    __listeners: { keydown: [] },
    addEventListener(type, handler) {
      if (this.__listeners[type] === undefined) this.__listeners[type] = []
      this.__listeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      if (this.__listeners[type] === undefined) return
      this.__listeners[type] = this.__listeners[type].filter((entry) => entry !== handler)
    },
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
//  回显表必须出现该模型词条与「持久化」列结局短标签；「从未探测」空态必须不出现。
//  2026-10-21 真机反馈后：单元格只放短标签（`已一致`），完整语义挂 title——
//  这里同时断言「短标签在文本里」+「长文案在 title 里」，两者缺一即红。）
if (statsPanelTree === null) {
  console.error('smoke: StatsPanel component was not exercised — cannot assert lastProbe restore (027-F3)')
  process.exit(1)
}
const statsText = []
collectText(statsPanelTree, statsText)
const statsTextAll = statsText.join('|')
if (!statsTextAll.includes('demo/m1') || !statsTextAll.includes('持久化') || !statsTextAll.includes('已一致')) {
  console.error('smoke: StatsPanel must rebuild probe results from persisted lastProbe with a short persisted label (027-F3/F4) — text=' + statsTextAll.slice(0, 400))
  process.exit(1)
}
const persistedTitles = []
;(function collectTitles(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.props?.title === 'string') persistedTitles.push(node.props.title)
  for (const child of node.children ?? []) collectTitles(child)
  collectTitles(node.props?.children)
})(statsPanelTree)
if (!persistedTitles.some((title) => title.includes('已与实测一致'))) {
  console.error('smoke: persisted short label must carry the full explanation in title (long sentence must not widen the column)')
  process.exit(1)
}
if (statsTextAll.includes('已与实测一致')) {
  console.error('smoke: persisted long explanation must NOT be inline in the cell (it stretches each row to 8 lines)')
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
if (!statsTextAll.includes('限流或额度不足')) {
  console.error('smoke: probe results must render blocked attribution (FEAT-004 ⑦) — got ' + statsTextAll)
  process.exit(1)
}
// 官方适配器结局：单元格只显示短标签「官方适配器」，完整解释在 title 里
if (!statsTextAll.includes('官方适配器')) {
  console.error('smoke: probe results must render the official-adapter short label (FEAT-004 ⑦) — got ' + statsTextAll)
  process.exit(1)
}
if (!persistedTitles.some((title) => title.includes('由 DeepSeek 官方适配器管理'))) {
  console.error('smoke: official-adapter outcome must keep its full explanation in title')
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
// （2026-10-21 真机反馈后语义变更：**空输入不铺候选列表**——一进页面就压出 20 条模型
//  是噪音。因此这里先断言「空输入无候选」，再模拟输入触发过滤，最后点击候选。）
const mdProps = { ...modelDefaultsEntry[2], lastProbe: STATS_FIXTURE.lastProbe }
function collectByProps(node, predicate, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (predicate(node)) into.push(node)
  for (const child of node.children ?? []) collectByProps(child, predicate, into)
  collectByProps(node.props?.children, predicate, into)
}
resetHooks('ModelDefaults')
const mdEmptyTree = modelDefaultsEntry[1](mdProps)
await effectsRan()
const emptyCandidates = []
collectByProps(mdEmptyTree, (node) => typeof node.props?.['data-model-key'] === 'string', emptyCandidates)
if (emptyCandidates.length !== 0) {
  console.error('smoke: model search must NOT list candidates while the query is empty (noise removal) — got ' + emptyCandidates.length)
  process.exit(1)
}
const searchFields = []
collectByProps(mdEmptyTree, (node) => node.$$ === 'component' && typeof node.tag?.name === 'string' && node.tag.name === 'SearchField', searchFields)
if (searchFields.length !== 1) {
  console.error('smoke: ModelDefaults must render exactly one SearchField, got ' + searchFields.length)
  process.exit(1)
}
searchFields[0].props.onChange('demo')
resetHooks('ModelDefaults')
const mdLoadedTree = modelDefaultsEntry[1](mdProps)
await effectsRan()
const searchCandidates = []
collectByProps(mdLoadedTree, (node) => typeof node.props?.['data-model-key'] === 'string' && typeof node.props?.onClick === 'function', searchCandidates)
const addCandidate = searchCandidates.find((node) => node.props['data-model-key'] === 'demo/m1')
if (addCandidate === undefined) {
  console.error('smoke: typing a query must list matching catalog candidates (demo/m1) for click-to-add (FEAT-004 §3.4.1)')
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
const copyTree = renderStats({ ...pausedStats[2], stats: copyStats, probe: copyProbe, piAiProviders: ['demo'] })
const copyText = flattenText(copyTree)
const copyTitles = []
;(function collectCopyTitles(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.props?.title === 'string') copyTitles.push(node.props.title)
  for (const child of node.children ?? []) collectCopyTitles(child)
  collectCopyTitles(node.props?.children)
})(copyTree)
if (!copyText.includes('模型未列')
  || !copyText.includes('其他适配器')) {
  console.error('smoke: skipped:not-in-pi-ai-config must split into configured-provider vs other-adapter copy (FEAT-004 §10.1) — got ' + copyText)
  process.exit(1)
}
// 短标签只是「铺得下」，完整语义必须在 title 里——否则用户永远读不到「该怎么处理」
if (!copyTitles.some((title) => title.includes('在 llm-pi-ai 的 demo 下没有这个模型'))
  || !copyTitles.some((title) => title.includes('该模型由其他适配器提供'))) {
  console.error('smoke: persisted short labels must carry the actionable explanation in title (FEAT-004 §10.1) — got ' + JSON.stringify(copyTitles))
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
  .find((node) => flattenText(node) === '一键探测思考档位（写回模型能力声明）')
if (probeButton === undefined) {
  console.error('smoke: probe-all button must be rendered in PageHeader with thinking-level scope (R3)')
  process.exit(1)
}
const probeButtonText = flattenText(probeButton)
if (!probeButtonText.includes('思考档位') || probeButtonText.includes('固化配置')) {
  console.error('smoke: probe-all button must name thinking levels and must not claim config persistence — got ' + probeButtonText)
  process.exit(1)
}
const probeDiagEntry = findComponent(probePage, 'DiagnosticsPanel')
resetHooks('DiagnosticsPanel')
const probeDiagText = probeDiagEntry === undefined ? '' : textOf(probeDiagEntry[1](probeDiagEntry[2]))
if (!probeDiagText.includes('不修改采样参数')) {
  console.error('smoke: testingNote must state that sampling parameters are not modified — got ' + probeDiagText.slice(0, 500))
  process.exit(1)
}
probeButton.props.onClick()
await sleep(80)
const { stats: probeDoneStats } = await renderPageStats()
const probeSummaryText = textOf(probeDoneStats[1](probeDoneStats[2]))
for (const expected of [
  '2 个由官方适配器管理（无需写入）',
  '1 个由其他适配器提供（无需写入）',
  '1 个暂无可写回档位',
  '采样参数、多模态与全局默认不受影响',
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
// 精确定位「最近调用」表再数行：早先版本按「7 个 td 的 tr」全局计数，聚合表列数
// 一改（8→7）就会把聚合行误算进来——那是计数器写法的问题，不是表格的问题。
let recentTable = null
;(function findRecentTable(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  const cls = node.props !== undefined && typeof node.props.className === 'string' ? node.props.className : ''
  if (node.$$ === 'table' && cls.includes('rl-recent-table')) { recentTable = node; return }
  for (const child of node.children ?? []) findRecentTable(child)
  findRecentTable(node.props?.children)
})(recentTree)
if (recentTable === null) {
  console.error('smoke: recent-calls table must carry the rl-recent-table class (structure guard)')
  process.exit(1)
}
let recentRowCount = 0
;(function countRecentRows(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'tbody') {
    recentRowCount += (node.children ?? []).filter((row) => row !== null && typeof row === 'object' && row.$$ === 'tr').length
    return
  }
  for (const child of node.children ?? []) countRecentRows(child)
  countRecentRows(node.props?.children)
})(recentTable)
if (recentRowCount !== 100) {
  console.error('smoke: recent-calls table must render the full 100-row wire window to match 「最近 100 条」 (R0-P3-7) — got ' + recentRowCount)
  process.exit(1)
}
if (!toolbarMetas.some((meta) => meta.includes('最近 100 条'))) {
  console.error('smoke: stats toolbar meta must stay aligned with the rendered recent window (100) (R0-P3-7)')
  process.exit(1)
}

// ── 2o. 布局回归（2026-10-21 真机反馈）：表格必须包在滚动容器里 ──────────────
// 宿主设置面板宽度有限：不包 `.rl-table-wrap`（或 `.rl-matrix-wrap`）时，列的
// min-width 撑不开 table，chips 列会被压到 90px → 7 个 chip 竖排成 7 行（用户截图）。
// 这条断言防止后续「顺手去掉 wrapper」把布局退回旧形态。
function collectTables(node, insideWrap, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  const cls = node.props !== undefined && typeof node.props.className === 'string' ? node.props.className : ''
  const wrapped = insideWrap || cls.includes('rl-table-wrap') || cls.includes('rl-matrix-wrap')
  if (node.$$ === 'table') into.push({ wrapped, className: cls, node })
  for (const child of node.children ?? []) collectTables(child, wrapped, into)
  collectTables(node.props?.children, wrapped, into)
}
const tables = []
collectTables(recentTree, false, tables)
if (tables.length === 0) {
  console.error('smoke: expected at least one table in StatsPanel to assert wrap contract')
  process.exit(1)
}
const unwrapped = tables.filter((item) => item.wrapped !== true)
if (unwrapped.length > 0) {
  console.error('smoke: every table must sit inside .rl-table-wrap/.rl-matrix-wrap (layout regression) — unwrapped: '
    + unwrapped.map((item) => item.className).join(', '))
  process.exit(1)
}
// 探测结果表：合并「拒绝/失败」后是 4 列（模型 / 可用 / 不可用 / 持久化）——
// 5 列表在宿主面板里放不下是这次真机反馈的根因，不允许退回。
const probeTables = tables.filter((item) => item.className.includes('rl-probe-table'))
const countHeaderCells = (item) => {
  const headRow = (item.node.children ?? []).find((child) => child !== null && typeof child === 'object' && child.$$ === 'thead')
  const headerCells = headRow !== undefined ? (headRow.children ?? []) : []
  return headerCells.reduce((sum, tr) => sum + ((tr?.children ?? []).filter((c) => c !== null && typeof c === 'object' && c.$$ === 'th').length), 0)
}
for (const item of probeTables) {
  const thCount = countHeaderCells(item)
  if (thCount !== 4) {
    console.error('smoke: probe results table must stay 4 columns (rejected+failed merged) — got ' + thCount)
    process.exit(1)
  }
}
// 模型聚合表：8 列 → 7 列（建议并入模型名）→ 6 列（错误率并入调用数）——两次真机
// 反馈都是「右端被裁」。列数回涨即红。
const aggTables = tables.filter((item) => item.className.includes('rl-stats-table') && !item.className.includes('rl-recent-table'))
for (const item of aggTables) {
  const thCount = countHeaderCells(item)
  if (thCount !== 6) {
    console.error('smoke: model aggregate table must stay 6 columns (suggestion + error-rate merged) — got ' + thCount)
    process.exit(1)
  }
}
// 固定列宽是 chips 能并排的前提（自动布局下 chips 列会被压到 70-90px 再竖排）。
// 样式表里没有 table-layout: fixed ≈ 布局会退回旧形态，直接判红。
const pageSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
if (!pageSource.includes('table-layout: fixed')) {
  console.error('smoke: stylesheet must keep table-layout: fixed (chips would collapse into one column per line)')
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

// ══ UX-004：四视图 + 模型中心工作台写路径 ═══════════════════════════════════
// 端点夹具（设计 §6 形状，含 params/modalities/contractHealth）；describe 夹具带
// models/modelParams/modelInput/defaults（FEAT-007 schema 形状）。端点可用时模型列表
// 以端点为准（vendor/x1 不在 catalog 中，能证明「端点为主」）。
const MODEL_ENDPOINT_FIXTURE = {
  version: 1,
  generatedAt: 1757100000000,
  routes: [
    { provider: 'demo', name: 'Demo', kind: 'pi-ai' },
    { provider: 'vendor', name: 'Vendor', kind: 'deepseek' },
  ],
  models: [
    {
      provider: 'demo', model: 'm1', name: 'M1', kind: 'pi-ai',
      input: { declared: ['text'], effective: ['text'], source: 'catalog' },
      reasoning: { efforts: ['high', 'max'], defaultEffort: 'high' },
      contextWindow: 200000, maxTokens: 128000,
      // 服务端 configured.params 是 effective（defaults ∪ modelParams）投影，不是显式覆盖。
      configured: { reasoningEffort: null, input: null, params: { temperature: 0.7 } },
    },
    {
      provider: 'demo', model: 'm2', name: 'M2', kind: 'pi-ai',
      input: { declared: ['text', 'image'], effective: ['text', 'image'], source: 'config' },
      reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' },
      contextWindow: 128000, maxTokens: 64000,
      configured: { reasoningEffort: 'high', input: ['text', 'image'], params: { temperature: 0.5 } },
    },
    {
      provider: 'vendor', model: 'x1', name: 'X1', kind: 'deepseek',
      input: { declared: ['text'], effective: ['text'], source: 'default' },
      reasoning: { efforts: ['high'], defaultEffort: 'high' },
      contextWindow: 64000, maxTokens: 32000,
      configured: { reasoningEffort: null, input: null, params: { temperature: 0.7 } },
    },
  ],
  params: [
    { id: 'temperature', type: 'number', min: 0, max: 2, step: 0.05, decimals: 2, label: { zh: '温度', en: 'Temperature' }, hostSupport: 'active' },
    { id: 'topP', type: 'number', min: 0, max: 1, step: 0.05, decimals: 2, label: { zh: 'Top P', en: 'Top P' }, hostSupport: 'reserved', reason: { zh: '宿主 0.2.2 的 GenerateOptions 无 topP 字段', en: 'DSH 0.2.2 GenerateOptions has no topP field' } },
    { id: 'topK', type: 'integer', min: 0, max: 1000000, step: 1, label: { zh: 'Top K', en: 'Top K' }, hostSupport: 'reserved', reason: { zh: '宿主 0.2.2 的 GenerateOptions 无 topK 字段', en: 'DSH 0.2.2 GenerateOptions has no topK field' } },
    { id: 'maxTokens', type: 'integer', min: 1, max: 2000000, step: 1, label: { zh: '最大输出', en: 'Max output' }, hostSupport: 'active' },
  ],
  modalities: [
    { id: 'text', label: { zh: '文本', en: 'Text' }, required: true },
    { id: 'image', label: { zh: '图像', en: 'Image' }, required: false },
  ],
  contractHealth: { ok: true, missing: [] },
}
const UX004_DESCRIBE = {
  result: {
    ok: true,
    value: {
      namespaces: [
        {
          ns: 'llm-reasoning',
          value: {
            enabled: true, level: 'high', models: { 'demo/m2': 'high' }, purposes: {}, syncDefaultAgent: false, statsPublic: false,
            defaults: { preset: 'balanced', params: { temperature: 0.7 } },
            modelParams: { 'demo/m2': { temperature: 0.5 } },
            modelInput: { 'demo/m2': ['text', 'image'] },
          },
        },
        { ns: 'llm-pi-ai', value: { providers: { demo: { reasoning: 'high', models: [{ id: 'm1', reasoningEfforts: { high: 'high', max: 'max' } }, { id: 'm2' }] } } } },
        { ns: 'llm-deepseek', value: { reasoningEffort: 'high' } },
      ],
    },
  },
}
API.settings.describe = async () => UX004_DESCRIBE
const ux004Fetch = async (url) => (url === '/reasoning-level-models'
  ? { ok: true, status: 200, json: async () => MODEL_ENDPOINT_FIXTURE }
  : { ok: true, status: 200, json: async () => STATS_FIXTURE })
sandbox.fetch = ux004Fetch
stores.clear()

const readPage = async () => renderTwice('ReasoningPage', pageElement.tag, pageElement.props)
const collectMatching = (tree, predicate) => {
  const out = []
  collectByProps(tree, predicate, out)
  return out
}
const spanOf = (tree) => { const text = []; collectText(tree, text); return text.join('|') }
const paramFieldEntries = (tree) => collectMatching(tree, (node) => node.$$ === 'component' && node.tag?.name === 'ParamNumberField')
const renderParamField = (entry, name) => {
  resetHooks(name)
  return entry.tag(entry.props)
}
const paramFieldInput = (tree, paramId, scope = 'model') => {
  const entry = paramFieldEntries(tree).find((node) => node.props?.param?.id === paramId)
  if (entry === undefined) return undefined
  const fieldTree = renderParamField(entry, 'ParamNumberField:' + scope + ':' + paramId)
  const input = collectMatching(fieldTree, (node) => node.$$ === 'input')[0]
  return { entry, tree: fieldTree, input }
}
const rerenderParamField = (entry, paramId, scope = 'model') => {
  resetHooks('ParamNumberField:' + scope + ':' + paramId)
  return entry.tag(entry.props)
}
const typeParamField = (entry, paramId, value, scope = 'model') => {
  const before = rerenderParamField(entry, paramId, scope)
  const beforeInput = collectMatching(before, (node) => node.$$ === 'input')[0]
  if (typeof beforeInput.props.onFocus === 'function') beforeInput.props.onFocus()
  beforeInput.props.onChange({ target: { value } })
  const after = rerenderParamField(entry, paramId, scope)
  return { tree: after, input: collectMatching(after, (node) => node.$$ === 'input')[0] }
}
const tabEntryOf = (tree) => findComponent(tree, 'TabBar')
const renderTabs = (tree) => {
  const entry = tabEntryOf(tree)
  if (entry === undefined) {
    console.error('smoke: UX-004 TabBar component missing from page tree')
    process.exit(1)
  }
  resetHooks('TabBar')
  return entry[1](entry[2])
}
const panelOf = (tree, id) => collectMatching(tree, (node) => node.$$ === 'section' && node.props?.id === 'rl-panel-' + id)[0]
const selectedTabId = (tabTree) => {
  const tabs = collectMatching(tabTree, (node) => node.$$ === 'button' && typeof node.props?.['data-view'] === 'string')
  const selected = tabs.filter((node) => node.props['aria-selected'] === true)
  return { tabs, selected: selected.map((node) => node.props['data-view']) }
}

// ── 2p. 四视图 tabs：button + aria-selected + aria-controls + 方向键 ───────────
let uxPage = await readPage()
let tabTree = renderTabs(uxPage)
let tabState = selectedTabId(tabTree)
if (tabState.tabs.length !== 4 || tabState.selected.join(',') !== 'models') {
  console.error('smoke: UX-004 must render 4 tab buttons with models selected by default — got ' + JSON.stringify(tabState))
  process.exit(1)
}
if (!tabState.tabs.every((node) => node.props.role === 'tab' && typeof node.props['aria-controls'] === 'string')) {
  console.error('smoke: UX-004 tabs must be role=tab with aria-controls (a11y)')
  process.exit(1)
}
for (const id of ['models', 'defaults', 'observability', 'diagnostics']) {
  const panel = panelOf(uxPage, id)
  if (panel === undefined || panel.props.role !== 'tabpanel') {
    console.error('smoke: UX-004 tabpanel #rl-panel-' + id + ' must exist with role=tabpanel')
    process.exit(1)
  }
  if ((panel.props.hidden === false) !== (id === 'models')) {
    console.error('smoke: UX-004 only the models panel may be visible initially — ' + id + ' hidden=' + panel.props.hidden)
    process.exit(1)
  }
}
const modelsTab = tabState.tabs.find((node) => node.props['data-view'] === 'models')
modelsTab.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: null })
uxPage = await readPage()
tabTree = renderTabs(uxPage)
tabState = selectedTabId(tabTree)
if (tabState.selected.join(',') !== 'defaults') {
  console.error('smoke: ArrowRight on the models tab must select the defaults tab (keyboard reachable) — got ' + JSON.stringify(tabState.selected))
  process.exit(1)
}
if ((panelOf(uxPage, 'defaults').props.hidden === false) !== true
  || (panelOf(uxPage, 'models').props.hidden === false) !== false) {
  console.error('smoke: switching tabs must move the visible panel')
  process.exit(1)
}
const defaultsTitles = collectMatching(panelOf(uxPage, 'defaults'), (node) => node.$$ === 'component' && node.tag?.name === 'Card')
  .map((node) => node.props.title)
if (!defaultsTitles.some((title) => String(title).includes('全局默认思考强度')) || !defaultsTitles.some((title) => String(title).includes('全局默认采样参数（模型未覆盖时生效）'))) {
  console.error('smoke: defaults view must render the global card and sampling presets — titles=' + JSON.stringify(defaultsTitles))
  process.exit(1)
}
const diagnosticsEntry = findComponent(uxPage, 'DiagnosticsPanel')
if (diagnosticsEntry === undefined) {
  console.error('smoke: UX-004 DiagnosticsPanel component missing')
  process.exit(1)
}
resetHooks('DiagnosticsPanel')
const diagnosticsTree = diagnosticsEntry[1](diagnosticsEntry[2])
const diagnosticsText = spanOf(diagnosticsTree)
const diagnosticsTitles = collectMatching(diagnosticsTree, (node) => node.$$ === 'component' && node.tag?.name === 'Card')
  .map((node) => node.props.title)
const diagnosticsChips = collectMatching(diagnosticsTree, (node) => node.$$ === 'component' && node.tag?.name === 'LevelChip')
  .map((node) => node.props.label)
if (!diagnosticsChips.includes('预留') || !diagnosticsChips.includes('生效')) {
  console.error('smoke: diagnostics parameter registry must badge 生效/预留 — got ' + JSON.stringify(diagnosticsChips))
  process.exit(1)
}
for (const expected of ['契约正常', '参数注册表', 'topP', '宿主 0.2.2 的 GenerateOptions 无 topP 字段']) {
  if (!diagnosticsText.includes(expected)) {
    console.error('smoke: diagnostics view missing "' + expected + '" — got ' + diagnosticsText.slice(0, 500))
    process.exit(1)
  }
}
if (!diagnosticsTitles.includes('扩展注册表')) {
  console.error('smoke: diagnostics view must render the extension registry card — titles=' + JSON.stringify(diagnosticsTitles))
  process.exit(1)
}
// T-F9：方向键全矩阵（Right/Down = +1，Left/Up = -1，循环）。
const arrowMatrix = [
  { key: 'ArrowRight', expected: 'defaults' },
  { key: 'ArrowDown', expected: 'defaults' },
  { key: 'ArrowLeft', expected: 'diagnostics' },
  { key: 'ArrowUp', expected: 'diagnostics' },
]
for (const arrowCase of arrowMatrix) {
  let matrixTabs = renderTabs(uxPage)
  let matrixState = selectedTabId(matrixTabs)
  if (matrixState.selected[0] !== 'models') {
    matrixState.tabs.find((node) => node.props['data-view'] === 'models').props.onClick()
    uxPage = await readPage()
    matrixTabs = renderTabs(uxPage)
    matrixState = selectedTabId(matrixTabs)
  }
  const fromTab = matrixState.tabs.find((node) => node.props['data-view'] === 'models')
  let prevented = false
  fromTab.props.onKeyDown({ key: arrowCase.key, preventDefault() { prevented = true }, currentTarget: null })
  uxPage = await readPage()
  const afterArrow = selectedTabId(renderTabs(uxPage)).selected[0]
  if (!prevented || afterArrow !== arrowCase.expected) {
    console.error('smoke: ' + arrowCase.key + ' on models must select ' + arrowCase.expected + ' and preventDefault — got ' + afterArrow + ' prevented=' + prevented)
    process.exit(1)
  }
}
// 回到模型视图，驱动工作台
tabState.tabs.find((node) => node.props['data-view'] === 'models').props.onClick()
uxPage = await readPage()

// ── 2q. 模型视图：端点分组 / 搜索 / 路由筛选 / 仅已覆盖 / 行内写路径 ─────────
let wbEntry = findComponent(uxPage, 'ModelWorkbench')
if (wbEntry === undefined) {
  console.error('smoke: UX-004 ModelWorkbench component missing from the models view')
  process.exit(1)
}
// T-F3 需要直接驱动真实组件（不是手写窄布局 markup），保留原始函数/props 快照。
const realWorkbenchFn = wbEntry[1]
const realWorkbenchProps = wbEntry[2]
const renderWb = (props, name = 'ModelWorkbench') => {
  const entry = findComponent(uxPage, 'ModelWorkbench')
  resetHooks(name)
  return entry[1]({ ...entry[2], ...props })
}
let wbTree = renderWb({ narrow: false })
await effectsRan()
const wbRoot = collectMatching(wbTree, (node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('rl-workbench'))[0]
if (wbRoot === undefined || !wbRoot.props.className.split(/\s+/).includes('rl-workbench-single')
  || wbRoot.props.className.split(/\s+/).includes('rl-workbench-narrow')) {
  console.error('smoke: no-selection wide workbench must be single-column (no empty 300px detail column) — got ' + JSON.stringify(wbRoot?.props?.className))
  process.exit(1)
}
if (collectMatching(wbTree, (node) => node.$$ === 'aside').length > 0) {
  console.error('smoke: no-selection workbench must not render an empty detail aside')
  process.exit(1)
}
const rowKeys = () => collectMatching(wbTree, (node) => typeof node.props?.['data-model-key'] === 'string')
  .map((node) => node.props['data-model-key'])
if (!rowKeys().includes('vendor/x1') || rowKeys().length !== 3) {
  console.error('smoke: endpoint models must drive the workbench (vendor/x1 proves endpoint-over-catalog) — got ' + JSON.stringify(rowKeys()))
  process.exit(1)
}
const providerGroups = collectMatching(wbTree, (node) => typeof node.props?.['data-provider'] === 'string')
if (providerGroups.length !== 2) {
  console.error('smoke: models must group by provider (2 groups) — got ' + providerGroups.length)
  process.exit(1)
}
// R2：PageHeader / Overview / 列表 toolbar 三处模型计数必须一致（canonical 去重后）。
const wbText = spanOf(wbTree)
const headerEntry = findComponent(uxPage, 'PageHeader')
const overviewEntry = findComponent(uxPage, 'Overview')
const toolbarEntry = findComponent(wbTree, 'Toolbar')
const headerModelCount = headerEntry?.[2]?.modelCount
const headerRouteCount = headerEntry?.[2]?.routeCount
const overviewModelCount = overviewEntry?.[2]?.rows?.length
const toolbarMeta = toolbarEntry?.[2]?.meta
if (headerModelCount !== 3 || headerRouteCount !== 2 || overviewModelCount !== 3 || toolbarMeta !== '显示 3 / 3 个模型') {
  console.error('smoke: PageHeader/Overview/list model counts must agree after router hiding — header=' + headerModelCount + '/' + headerRouteCount + ' overview=' + overviewModelCount + ' toolbar=' + JSON.stringify(toolbarMeta))
  process.exit(1)
}
const appliedSpan = spanOf(uxPage)
if (!/已应用：[^|]*\/ 3 个模型/.test(appliedSpan)) {
  console.error('smoke: applied summary must use canonical model count (3) — got ' + appliedSpan.slice(0, 400))
  process.exit(1)
}
if (!wbText.includes('温度 0.5') || !wbText.includes('图像 开')) {
  console.error('smoke: model row must summarise the effective custom configuration — got ' + wbText.slice(0, 400))
  process.exit(1)
}
if (wbText.includes('温度 0.7*')) {
  console.error('smoke: endpoint.configured.params is effective (defaults ∪ overrides) — it must NOT mark inherited defaults as model overrides')
  process.exit(1)
}
// 搜索
const wbSearch = collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'SearchField')[0]
if (wbSearch === undefined) {
  console.error('smoke: model view must render a SearchField')
  process.exit(1)
}
wbSearch.props.onChange('m2')
wbTree = renderWb({ narrow: false })
if (rowKeys().join(',') !== 'demo/m2') {
  console.error('smoke: model search must filter by query — got ' + JSON.stringify(rowKeys()))
  process.exit(1)
}
wbSearch.props.onChange('')
wbTree = renderWb({ narrow: false })
// 路由筛选
const providerSelect = collectMatching(wbTree, (node) => node.$$ === 'select' && node.props?.['data-provider-filter'] !== undefined)[0]
providerSelect.props.onChange({ target: { value: 'vendor' } })
wbTree = renderWb({ narrow: false })
if (rowKeys().join(',') !== 'vendor/x1') {
  console.error('smoke: route filter must narrow to the selected provider — got ' + JSON.stringify(rowKeys()))
  process.exit(1)
}
providerSelect.props.onChange({ target: { value: 'all' } })
wbTree = renderWb({ narrow: false })
// 仅显示已覆盖
const overriddenBtn = collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'Button' && node.props?.['data-only-overridden'] !== undefined)[0]
overriddenBtn.props.onClick()
wbTree = renderWb({ narrow: false })
if (rowKeys().join(',') !== 'demo/m2') {
  console.error('smoke: 「仅显示已覆盖」must keep only overridden models — got ' + JSON.stringify(rowKeys()))
  process.exit(1)
}
const offOverriddenBtn = collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'Button' && node.props?.['data-only-overridden'] !== undefined)[0]
offOverriddenBtn.props.onClick()
wbTree = renderWb({ narrow: false })
if (rowKeys().length !== 3) {
  console.error('smoke: turning 「仅显示已覆盖」off must restore every model — got ' + JSON.stringify(rowKeys()))
  process.exit(1)
}
// 行级配置来源：只有一个来源控件；custom 0 写，follow 一次清三处
let writesBefore = writeCalls.length
const sourceSelects = collectMatching(wbTree, (node) => node.$$ === 'select' && node.props?.['data-model-source'] !== undefined)
if (sourceSelects.length !== 3 || collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'EffortSelect').length !== 0
  || collectMatching(wbTree, (node) => node.$$ === 'button' && node.props?.['data-model-image'] !== undefined).length !== 0) {
  console.error('smoke: row must expose one source control and no inline effort/image editors — got sources=' + sourceSelects.length)
  process.exit(1)
}
const m1Source = sourceSelects.find((node) => node.props['data-model-source'] === 'demo/m1')
m1Source.props.onChange({ target: { value: 'custom' } })
await effectsRan()
if (writeCalls.length !== writesBefore) {
  console.error('smoke: switching a row to Custom must not write')
  process.exit(1)
}
wbTree = renderWb({ narrow: false })
if (!spanOf(wbTree).includes('切到「自定义」不写入')) {
  console.error('smoke: switching to Custom must point the user to the details')
  process.exit(1)
}
const m1SourceAfterCustom = collectMatching(wbTree, (node) => node.$$ === 'select' && node.props?.['data-model-source'] === 'demo/m1')[0]
if (m1SourceAfterCustom === undefined || m1SourceAfterCustom.props.value !== 'follow') {
  console.error('smoke: Custom is a hint only; the row source select must stay on Follow global until a dimension is overridden')
  process.exit(1)
}
writesBefore = writeCalls.length
const m2Source = collectMatching(wbTree, (node) => node.$$ === 'select' && node.props?.['data-model-source'] === 'demo/m2')[0]
m2Source.props.onChange({ target: { value: 'follow' } })
await effectsRan()
const sourceMutates = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
if (sourceMutates.length !== 1 || !['models', 'modelParams', 'modelInput'].every((field) =>
  sourceMutates[0].ops.some((op) => op.op === 'unset' && JSON.stringify(op.path) === JSON.stringify([field, 'demo/m2'])))) {
  console.error('smoke: Follow global must clear models/modelParams/modelInput in one mutate — got ' + JSON.stringify(writeCalls.slice(writesBefore)))
  process.exit(1)
}
wbTree = renderWb({ narrow: false })

// ── 2r. 详情面板：Esc 关闭 / 参数跟随 / 参数写入 / 恢复模型默认 / 窄屏展开 ────
const openButton = collectMatching(wbTree, (node) => node.$$ === 'button' && node.props?.['data-model-open'] === 'demo/m2')[0]
openButton.props.onClick({ stopPropagation() {} })
wbTree = renderWb({ narrow: false })
await effectsRan()
let detailEntry = findComponent(wbTree, 'ModelDetail')
if (detailEntry === undefined) {
  console.error('smoke: clicking a model row must open the detail panel')
  process.exit(1)
}
if (!collectMatching(wbTree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rl-workbench-detail')).length) {
  console.error('smoke: wide layout must render the detail as a right-hand aside')
  process.exit(1)
}
resetHooks('ModelDetail')
let detailTree = detailEntry[1](detailEntry[2])
const detailText = spanOf(detailTree)
if (!detailText.includes('身份') || !detailText.includes('上下文') || !detailText.includes('采样参数')) {
  console.error('smoke: detail must render identity/context/params sections — got ' + detailText.slice(0, 400))
  process.exit(1)
}
// T-F9：四个采样参数都必须有控件；生效/预留徽章 + 预留原因必须在详情里可见。
const detailParamIds = paramFieldEntries(detailTree).map((entry) => entry.props.param.id)
for (const paramId of ['temperature', 'topP', 'topK', 'maxTokens']) {
  if (!detailParamIds.includes(paramId)) {
    console.error('smoke: detail must render a ' + paramId + ' control — got ' + JSON.stringify(detailParamIds))
    process.exit(1)
  }
  const field = paramFieldInput(detailTree, paramId)
  if (field === undefined || field.input === undefined) {
    console.error('smoke: detail ' + paramId + ' field must render an input')
    process.exit(1)
  }
}
const detailParamChips = collectMatching(detailTree, (node) => node.$$ === 'component' && node.tag?.name === 'ParamHostChip')
  .flatMap((entry) => {
    const chipTree = entry.tag(entry.props)
    return collectMatching(chipTree, (node) => node.$$ === 'component' && node.tag?.name === 'LevelChip')
      .map((node) => node.props.label)
  })
if (!detailParamChips.includes('生效') || !detailParamChips.includes('预留')) {
  console.error('smoke: detail params must badge 生效/预留 — got ' + JSON.stringify(detailParamChips))
  process.exit(1)
}
for (const expected of ['宿主 0.2.2 的 GenerateOptions 无 topP 字段', '宿主 0.2.2 的 GenerateOptions 无 topK 字段']) {
  if (!detailText.includes(expected)) {
    console.error('smoke: detail reserved params must show the reason "' + expected + '" — got ' + detailText.slice(0, 600))
    process.exit(1)
  }
}
// 参数写入（modelParams 整体 set；R2：输入只在 blur/Enter 提交）
writesBefore = writeCalls.length
const tempField = paramFieldInput(detailTree, 'temperature')
if (tempField === undefined) {
  console.error('smoke: detail must render a temperature input')
  process.exit(1)
}
const typedTemp = typeParamField(tempField.entry, 'temperature', '0.3')
if (writeCalls.length !== writesBefore) {
  console.error('smoke: typing a param must not write before blur/Enter — got ' + JSON.stringify(writeCalls.slice(writesBefore)))
  process.exit(1)
}
typedTemp.input.props.onBlur()
await effectsRan()
let mutateCalls = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
if (!mutateCalls.some((call) => call.ops.some((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['modelParams', 'demo/m2']) && op.value.temperature === 0.3))) {
  console.error('smoke: parameter input must write modelParams[key] via mutate set — got ' + JSON.stringify(writeCalls.slice(writesBefore)))
  process.exit(1)
}
// 跟随默认（删字段后整体 set）
writesBefore = writeCalls.length
const followBtn = collectMatching(detailTree, (node) => node.$$ === 'component' && node.tag?.name === 'Button' && node.props?.['data-param-follow'] === 'temperature')[0]
if (followBtn === undefined) {
  console.error('smoke: detail parameter row must expose 「跟随默认」')
  process.exit(1)
}
followBtn.props.onClick()
await effectsRan()
mutateCalls = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
if (!mutateCalls.some((call) => call.ops.some((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['modelParams', 'demo/m2']) && !Object.prototype.hasOwnProperty.call(op.value, 'temperature')))) {
  console.error('smoke: 「跟随默认」must remove the field from the model param bag — got ' + JSON.stringify(writeCalls.slice(writesBefore)))
  process.exit(1)
}
// 恢复此模型默认：三条 unset
writesBefore = writeCalls.length
const resetBtn = collectMatching(detailTree, (node) => node.$$ === 'component' && node.tag?.name === 'Button' && node.props?.['data-reset-model'] === 'demo/m2')[0]
if (resetBtn === undefined) {
  console.error('smoke: detail must expose 「恢复此模型默认」')
  process.exit(1)
}
resetBtn.props.onClick()
await effectsRan()
mutateCalls = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
const resetOps = mutateCalls.flatMap((call) => call.ops)
for (const path of [['models', 'demo/m2'], ['modelParams', 'demo/m2'], ['modelInput', 'demo/m2']]) {
  if (!resetOps.some((op) => op.op === 'unset' && JSON.stringify(op.path) === JSON.stringify(path))) {
    console.error('smoke: reset-model must unset ' + path.join('.') + ' — got ' + JSON.stringify(resetOps))
    process.exit(1)
  }
}
// Esc 关闭（document 监听；冒烟桩提供 addEventListener 记录）
if (typeof sandbox.document.addEventListener !== 'function') {
  console.error('smoke: document.addEventListener stub missing — cannot assert Esc-close')
  process.exit(1)
}
if ((sandbox.document.__listeners.keydown ?? []).length === 0) {
  console.error('smoke: ModelDetail must register an Escape keydown listener while open')
  process.exit(1)
}
for (const handler of sandbox.document.__listeners.keydown) handler({ key: 'Escape' })
wbTree = renderWb({ narrow: false })
if (findComponent(wbTree, 'ModelDetail') !== undefined) {
  console.error('smoke: Escape must close the model detail panel')
  process.exit(1)
}
// 窄屏展开行
const reopen = collectMatching(wbTree, (node) => node.$$ === 'button' && node.props?.['data-model-open'] === 'demo/m2')[0]
reopen.props.onClick({ stopPropagation() {} })
wbTree = renderWb({ narrow: true })
const inlineDetails = collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'ModelDetail' && node.props?.inline === true)
if (inlineDetails.length !== 1) {
  console.error('smoke: narrow layout must expand the detail inline under the selected row — got ' + inlineDetails.length)
  process.exit(1)
}
if (typeof wbTree === 'object' && collectMatching(wbTree, (node) => node.$$ === 'aside').length !== 0) {
  console.error('smoke: narrow layout must not render the wide right-hand aside')
  process.exit(1)
}
// 容器窄判定（真实设置页 modal 约 559px、视口 1440px）：compact 命中时必须行内展开且不预留右列。
wbTree = renderWb({ narrow: false, compact: true })
const compactRoot = collectMatching(wbTree, (node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('rl-workbench'))[0]
if (compactRoot === undefined || !compactRoot.props.className.split(/\s+/).includes('rl-workbench-narrow')
  || !compactRoot.props.className.split(/\s+/).includes('rl-workbench-single')) {
  console.error('smoke: container-compact workbench must switch to single-column + narrow rows — got ' + JSON.stringify(compactRoot?.props?.className))
  process.exit(1)
}
if (collectMatching(wbTree, (node) => node.$$ === 'component' && node.tag?.name === 'ModelDetail' && node.props?.inline === true).length !== 1
  || collectMatching(wbTree, (node) => node.$$ === 'aside').length !== 0) {
  console.error('smoke: container-compact workbench must inline the detail and omit the aside')
  process.exit(1)
}

// ── 2r-2. R2 参数输入：draft 不写、blur/Enter 一次写、Escape/非法值不写 ──────
const commitDetailEntry = findComponent(wbTree, 'ModelDetail')
resetHooks('ModelDetail')
const commitDetailTree = commitDetailEntry[1](commitDetailEntry[2])
const commitField = paramFieldInput(commitDetailTree, 'temperature')
let commitWritesBefore = writeCalls.length
let typedCommit = typeParamField(commitField.entry, 'temperature', '0.')
if (writeCalls.length !== commitWritesBefore) {
  console.error('smoke: typing "0." must not write the model param')
  process.exit(1)
}
typedCommit = typeParamField(commitField.entry, 'temperature', '0.7')
if (writeCalls.length !== commitWritesBefore) {
  console.error('smoke: typing "0.7" must not write before blur/Enter')
  process.exit(1)
}
typedCommit.input.props.onBlur()
await effectsRan()
let commitMutates = writeCalls.slice(commitWritesBefore).filter((call) => call.method === 'mutate')
if (commitMutates.length !== 1
  || !commitMutates[0].ops.some((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['modelParams', 'demo/m2']) && op.value.temperature === 0.7)) {
  console.error('smoke: blur must commit exactly one modelParams write — got ' + JSON.stringify(writeCalls.slice(commitWritesBefore)))
  process.exit(1)
}
commitWritesBefore = writeCalls.length
typedCommit = typeParamField(commitField.entry, 'temperature', '0.9')
typedCommit.input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
await effectsRan()
commitMutates = writeCalls.slice(commitWritesBefore).filter((call) => call.method === 'mutate')
if (commitMutates.length !== 1 || !commitMutates[0].ops.some((op) => op.op === 'set' && op.value.temperature === 0.9)) {
  console.error('smoke: Enter must commit exactly one modelParams write — got ' + JSON.stringify(writeCalls.slice(commitWritesBefore)))
  process.exit(1)
}
typedCommit.input.props.onBlur()
await effectsRan()
if (writeCalls.length !== commitWritesBefore + 1) {
  console.error('smoke: blur after Enter must not duplicate the modelParams write — got ' + JSON.stringify(writeCalls.slice(commitWritesBefore)))
  process.exit(1)
}
commitWritesBefore = writeCalls.length
typedCommit = typeParamField(commitField.entry, 'temperature', '1.1')
typedCommit.input.props.onKeyDown({ key: 'Escape', preventDefault() {} })
await effectsRan()
if (writeCalls.length !== commitWritesBefore) {
  console.error('smoke: Escape must cancel the draft without writing')
  process.exit(1)
}
const escapedFieldTree = rerenderParamField(commitField.entry, 'temperature')
const escapedInput = collectMatching(escapedFieldTree, (node) => node.$$ === 'input')[0]
if (escapedInput.props.value !== '0.5') {
  console.error('smoke: Escape must restore the committed value — got ' + JSON.stringify(escapedInput.props.value))
  process.exit(1)
}
commitWritesBefore = writeCalls.length
typedCommit = typeParamField(commitField.entry, 'temperature', 'abc')
typedCommit.input.props.onBlur()
await effectsRan()
if (writeCalls.length !== commitWritesBefore) {
  console.error('smoke: invalid model param must not write')
  process.exit(1)
}
let invalidFieldTree = rerenderParamField(commitField.entry, 'temperature')
let invalidInput = collectMatching(invalidFieldTree, (node) => node.$$ === 'input')[0]
if (invalidInput.props['aria-invalid'] !== true || !spanOf(invalidFieldTree).includes('请输入有效数字')) {
  console.error('smoke: invalid model param must set aria-invalid + inline error — got ' + JSON.stringify(invalidInput.props) + ' text=' + spanOf(invalidFieldTree))
  process.exit(1)
}
typedCommit = typeParamField(commitField.entry, 'temperature', '9')
typedCommit.input.props.onBlur()
await effectsRan()
if (writeCalls.length !== commitWritesBefore) {
  console.error('smoke: out-of-range model param must not write')
  process.exit(1)
}
invalidFieldTree = rerenderParamField(commitField.entry, 'temperature')
invalidInput = collectMatching(invalidFieldTree, (node) => node.$$ === 'input')[0]
if (invalidInput.props['aria-invalid'] !== true || !spanOf(invalidFieldTree).includes('需在 0–2 之间')) {
  console.error('smoke: out-of-range model param must show the range error — got ' + spanOf(invalidFieldTree))
  process.exit(1)
}

// ── 2r-3. R2b：隐藏 router，base 行内部同步全部 writeKeys ─────────────────────
const hiddenCounts = [3, 2, 2, 2, 2, 2, 2]
const hiddenProviders = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
const hiddenModels = []
let modelOrdinal = 0
for (let index = 0; index < hiddenProviders.length; index += 1) {
  for (let j = 0; j < hiddenCounts[index]; j += 1) {
    modelOrdinal += 1
    hiddenModels.push({
      provider: hiddenProviders[index], model: 'm' + modelOrdinal, name: 'Model ' + modelOrdinal, kind: 'pi-ai',
      input: { declared: ['text'], effective: ['text'], source: 'catalog' },
      reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' },
      contextWindow: 200000, maxTokens: 128000,
      configured: { reasoningEffort: null, input: null, params: {} },
    })
  }
}
for (const provider of ['alpha', 'beta']) {
  for (const entry of hiddenModels.filter((item) => item.provider === provider)) {
    hiddenModels.push({ ...entry, provider: provider + '-router' })
  }
}
hiddenModels.push({
  provider: 'alpha-router', model: 'ghost', name: 'Ghost', kind: 'pi-ai',
  input: { declared: ['text'], effective: ['text'], source: 'catalog' },
  reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' },
  contextWindow: 200000, maxTokens: 128000,
  configured: { reasoningEffort: null, input: null, params: {} },
})
const hiddenFeed = {
  version: 1, generatedAt: Date.now(),
  routes: hiddenProviders.map((provider) => ({ provider, name: provider, kind: 'pi-ai' }))
    .concat(['alpha', 'beta'].map((provider) => ({ provider: provider + '-router', name: provider + '-router', kind: 'pi-ai' }))),
  models: hiddenModels,
  params: MODEL_ENDPOINT_FIXTURE.params,
  modalities: MODEL_ENDPOINT_FIXTURE.modalities,
  contractHealth: { ok: true, missing: [] },
}
const hiddenValue = {
  ...UX004_DESCRIBE.result.value.namespaces[0].value,
  level: 'high',
  models: { 'alpha/m1': 'high', 'alpha-router/m1': 'max' },
  modelInput: { 'alpha/m1': ['text', 'image'], 'alpha-router/m1': ['text', 'image'] },
  modelParams: { 'alpha/m1': { temperature: 0.2 }, 'alpha-router/m1': { temperature: 0.8 } },
}
const hiddenOriginalDescribe = API.settings.describe
const hiddenOriginalFetch = sandbox.fetch
API.settings.describe = async () => ({
  result: {
    ok: true,
    value: {
      namespaces: [
        { ns: 'llm-reasoning', value: hiddenValue },
        { ns: 'llm-pi-ai', value: { providers: { alpha: { reasoning: 'high', models: [] }, 'alpha-router': { reasoning: 'max', models: [] } } } },
        ...UX004_DESCRIBE.result.value.namespaces.slice(1).filter((entry) => entry.ns !== 'llm-pi-ai'),
      ],
    },
  },
})
sandbox.fetch = async (url) => (url === '/reasoning-level-models'
  ? { ok: true, status: 200, json: async () => hiddenFeed }
  : { ok: true, status: 200, json: async () => STATS_FIXTURE })
stores.delete('ReasoningPage')
stores.delete('ModelWorkbench')
let hiddenPage = await readPage()
const hiddenApplied = collectMatching(hiddenPage, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rl-applied'))[0]
const hiddenAppliedText = hiddenApplied === undefined ? '' : spanOf(hiddenApplied)
if (hiddenApplied === undefined || hiddenAppliedText.includes('alpha-router') || hiddenAppliedText.includes('≠全局')
  || hiddenApplied.props.className.includes('rl-applied-warn') || !hiddenAppliedText.includes('alpha=高')) {
  console.error('smoke: applied summary must ignore -router providers and not warn on their level — got ' + JSON.stringify({ text: hiddenAppliedText, className: hiddenApplied?.props?.className }))
  process.exit(1)
}
let hiddenWbEntry = findComponent(hiddenPage, 'ModelWorkbench')
resetHooks('ModelWorkbench')
let hiddenWb = hiddenWbEntry[1](hiddenWbEntry[2])
const hiddenRows = collectMatching(hiddenWb, (node) => typeof node.props?.['data-model-key'] === 'string')
if (hiddenRows.length !== 15 || new Set(hiddenRows.map((node) => node.props['data-model-key'].split('/')[0])).size !== 7) {
  console.error('smoke: 7 providers × 15 models must render 15 rows / 7 groups after hiding routers — got ' + hiddenRows.length)
  process.exit(1)
}
if (hiddenRows.some((node) => node.props['data-model-key'].includes('router') || node.props['data-model-route-keys'] !== undefined)) {
  console.error('smoke: router rows/route attributes must stay hidden')
  process.exit(1)
}
const alphaRow = hiddenRows.find((node) => node.props['data-model-key'] === 'alpha/m1')
if (alphaRow.props['data-model-write-keys'] !== 'alpha/m1,alpha-router/m1'
  || collectMatching(hiddenWb, (node) => node.props?.['data-model-key'] === 'alpha-router/ghost').length !== 0) {
  console.error('smoke: base row must carry hidden router write keys and hide router-only models — got ' + JSON.stringify(alphaRow.props))
  process.exit(1)
}
const hiddenHeader = findComponent(hiddenPage, 'PageHeader')
if (hiddenHeader?.[2]?.routeCount !== 7 || hiddenHeader?.[2]?.modelCount !== 15) {
  console.error('smoke: header must show 7 providers / 15 models — got ' + JSON.stringify(hiddenHeader?.[2]))
  process.exit(1)
}
const hiddenToolbar = findComponent(hiddenWb, 'Toolbar')
if (hiddenToolbar?.[2]?.meta !== '显示 15 / 15 个模型') {
  console.error('smoke: toolbar must show 15 / 15 — got ' + JSON.stringify(hiddenToolbar?.[2]?.meta))
  process.exit(1)
}
const hiddenOverview = findComponent(hiddenPage, 'Overview')
resetHooks('Overview')
const hiddenOverviewTree = hiddenOverview === undefined ? null : hiddenOverview[1](hiddenOverview[2])
if (hiddenOverview?.[2]?.rows?.length !== 15 || hiddenOverviewTree === null || !spanOf(hiddenOverviewTree).includes('15 个模型 · 7 个模型提供商')) {
  console.error('smoke: overview must state 15 models / 7 providers — got ' + (hiddenOverviewTree === null ? 'missing' : spanOf(hiddenOverviewTree).slice(0, 200)))
  process.exit(1)
}
const hiddenFilter = collectMatching(hiddenWb, (node) => node.$$ === 'select' && node.props?.['data-provider-filter'] !== undefined)[0]
const hiddenFilterOptions = collectMatching(hiddenFilter, (node) => node.$$ === 'option').map((node) => node.props.value)
if (hiddenFilterOptions.join(',') !== 'all,alpha,beta,gamma,delta,epsilon,zeta,eta') {
  console.error('smoke: provider filter must list exactly the 7 visible base providers — got ' + JSON.stringify(hiddenFilterOptions))
  process.exit(1)
}
const hiddenText = spanOf(hiddenWb)
for (const forbidden of ['路由版', '真实路由', '混合', '路由筛选', '全部路由', '各路由配置不一致', '已覆盖', '继承', '跟随默认', '服务商', '路由']) {
  if (hiddenText.includes(forbidden)) {
    console.error('smoke: router terminology must be hidden from the workbench — found ' + forbidden)
    process.exit(1)
  }
}
const hiddenPageText = spanOf(hiddenPage)
if (hiddenPageText.includes('服务商') || hiddenPageText.includes('路由') || !hiddenPageText.includes('模型提供商')) {
  console.error('smoke: visible copy must use 模型提供商 and contain no 服务商/路由 — got ' + hiddenPageText.slice(0, 500))
  process.exit(1)
}
if (!spanOf(hiddenPage).includes('已应用：') || !/已应用：[^|]*\/ 15 个模型/.test(spanOf(hiddenPage))) {
  console.error('smoke: applied summary must use 15 visible models')
  process.exit(1)
}
// 行级 follow：一次 mutate 清三处（含隐藏 router key），undo 全恢复
let hiddenWritesBefore = writeCalls.length
const alphaSource = collectMatching(hiddenWb, (node) => node.$$ === 'select' && node.props?.['data-model-source'] === 'alpha/m1')[0]
alphaSource.props.onChange({ target: { value: 'follow' } })
await effectsRan()
await sleep(20)
const hiddenFollowMutates = writeCalls.slice(hiddenWritesBefore).filter((call) => call.method === 'mutate')
if (hiddenFollowMutates.length !== 1 || !['alpha/m1', 'alpha-router/m1'].every((key) =>
  ['models', 'modelInput', 'modelParams'].every((field) => hiddenFollowMutates[0].ops.some((op) => op.op === 'unset' && JSON.stringify(op.path) === JSON.stringify([field, key]))))) {
  console.error('smoke: row follow must clear three dimensions for base + hidden router keys in one mutate — got ' + JSON.stringify(writeCalls.slice(hiddenWritesBefore)))
  process.exit(1)
}
hiddenPage = await readPage()
const hiddenFollowToast = findComponent(hiddenPage, 'Toast')
if (hiddenFollowToast === undefined || hiddenFollowToast[2].actionLabel !== '撤销') {
  console.error('smoke: row follow must offer undo')
  process.exit(1)
}
hiddenWritesBefore = writeCalls.length
hiddenFollowToast[2].onAction()
await effectsRan()
const hiddenUndoWrites = writeCalls.slice(hiddenWritesBefore)
const hiddenUndoPatch = hiddenUndoWrites.find((call) => call.method === 'update' && call.patch?.models?.['alpha/m1'] === 'high' && call.patch?.models?.['alpha-router/m1'] === 'max')
const hiddenUndoOps = hiddenUndoWrites.filter((call) => call.method === 'mutate').flatMap((call) => call.ops)
if (hiddenUndoPatch === undefined || !['alpha/m1', 'alpha-router/m1'].every((key) =>
  ['modelParams', 'modelInput'].every((field) => hiddenUndoOps.some((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify([field, key]))))) {
  console.error('smoke: row follow undo must restore models + params + inputs for all write keys — got ' + JSON.stringify(hiddenUndoWrites))
  process.exit(1)
}
hiddenPage = await readPage()
hiddenWbEntry = findComponent(hiddenPage, 'ModelWorkbench')
resetHooks('ModelWorkbench')
hiddenWb = hiddenWbEntry[1](hiddenWbEntry[2])
const hiddenOpen = collectMatching(hiddenWb, (node) => node.$$ === 'button' && node.props?.['data-model-open'] === 'alpha/m1')[0]
hiddenOpen.props.onClick({ stopPropagation() {} })
resetHooks('ModelWorkbench')
hiddenWb = hiddenWbEntry[1](hiddenWbEntry[2])
const hiddenDetailEntry = findComponent(hiddenWb, 'ModelDetail')
resetHooks('ModelDetail')
const hiddenDetail = hiddenDetailEntry[1](hiddenDetailEntry[2])
const hiddenDetailText = spanOf(hiddenDetail)
const hiddenEffortEntry = findComponent(hiddenDetail, 'EffortSelect')
resetHooks('EffortSelect')
const hiddenEffortTree = hiddenEffortEntry[1](hiddenEffortEntry[2])
if (!hiddenDetailText.includes('思考强度') || !hiddenDetailText.includes('多模态') || !hiddenDetailText.includes('采样参数 · 温度')
  || !/跟随全局思考强度（[^）]+）/.test(spanOf(hiddenEffortTree)) || !hiddenDetailText.includes('来源：')
  || !/默认档位：[^|]+/.test(hiddenDetailText) || hiddenDetailText.includes('default:')
  || !hiddenDetailText.includes('改为跟随全局默认（0.7）')
  || (hiddenDetailText.split('改为跟随宿主默认').length - 1) !== 3
  || hiddenDetailText.includes('已跟随宿主')
  || !/跟随宿主目录（[^）]+）/.test(hiddenDetailText) || !hiddenDetailText.includes('自定义：仅文本')
  || !hiddenDetailText.includes('自定义：文本 + 图像')) {
  console.error('smoke: detail must label every dimension with source/effective — got ' + hiddenDetailText.slice(0, 500) + ' effort=' + (hiddenEffortTree === null ? 'missing' : spanOf(hiddenEffortTree)))
  process.exit(1)
}
// 详情思考：写两 key
hiddenWritesBefore = writeCalls.length
const hiddenEffort = collectMatching(hiddenEffortTree, (node) => node.$$ === 'select')[0]
hiddenEffort.props.onChange({ target: { value: 'max' } })
await effectsRan()
const hiddenEffortPatch = writeCalls.slice(hiddenWritesBefore).find((call) => call.method === 'update' && call.patch?.models?.['alpha/m1'] === 'max' && call.patch?.models?.['alpha-router/m1'] === 'max')
if (hiddenEffortPatch === undefined) {
  console.error('smoke: detail thinking level must write both base + hidden router keys')
  process.exit(1)
}
// 详情多模态：跟随目录一次 unset 两 key；自定义 image 写两 key
hiddenWritesBefore = writeCalls.length
const hiddenInput = collectMatching(hiddenDetail, (node) => node.$$ === 'select' && node.props?.['data-detail-image'] !== undefined)[0]
hiddenInput.props.onChange({ target: { value: 'follow' } })
await effectsRan()
const hiddenInputFollow = writeCalls.slice(hiddenWritesBefore).filter((call) => call.method === 'mutate').flatMap((call) => call.ops)
if (!['alpha/m1', 'alpha-router/m1'].every((key) => hiddenInputFollow.some((op) => op.op === 'unset' && JSON.stringify(op.path) === JSON.stringify(['modelInput', key])))) {
  console.error('smoke: multimodal follow must unset modelInput for all write keys — got ' + JSON.stringify(hiddenInputFollow))
  process.exit(1)
}
hiddenWritesBefore = writeCalls.length
hiddenInput.props.onChange({ target: { value: 'image' } })
await effectsRan()
const hiddenInputPatch = writeCalls.slice(hiddenWritesBefore).find((call) => call.method === 'update' && call.patch?.modelInput?.['alpha/m1']?.join(',') === 'text,image' && call.patch?.modelInput?.['alpha-router/m1']?.join(',') === 'text,image')
if (hiddenInputPatch === undefined) {
  console.error('smoke: multimodal custom must write both keys')
  process.exit(1)
}
// 详情参数：写两 key
const hiddenTempField = paramFieldInput(hiddenDetail, 'temperature')
hiddenWritesBefore = writeCalls.length
const hiddenTyped = typeParamField(hiddenTempField.entry, 'temperature', '0.4')
hiddenTyped.input.props.onBlur()
await effectsRan()
const hiddenParamOps = writeCalls.slice(hiddenWritesBefore).filter((call) => call.method === 'mutate').flatMap((call) => call.ops)
if (!['alpha/m1', 'alpha-router/m1'].every((key) => hiddenParamOps.some((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['modelParams', key]) && op.value.temperature === 0.4))) {
  console.error('smoke: detail parameter must write both keys — got ' + JSON.stringify(hiddenParamOps))
  process.exit(1)
}
API.settings.describe = hiddenOriginalDescribe
sandbox.fetch = hiddenOriginalFetch
stores.delete('ReasoningPage')
stores.delete('ModelWorkbench')
uxPage = await readPage()
// ── 2s. 采样预设 + 默认参数写路径（defaults.preset + defaults.params）────────
const presetEntry = findComponent(uxPage, 'PresetsPanel')
if (presetEntry === undefined) {
  console.error('smoke: PresetsPanel component missing from the defaults view')
  process.exit(1)
}
resetHooks('PresetsPanel')
const presetsTree = presetEntry[1](presetEntry[2])
writesBefore = writeCalls.length
const preciseBtn = collectMatching(presetsTree, (node) => node.$$ === 'button' && node.props?.['data-preset'] === 'precise')[0]
if (preciseBtn === undefined) {
  console.error('smoke: preset chips must render precise/balanced/creative buttons')
  process.exit(1)
}
preciseBtn.props.onClick()
await effectsRan()
mutateCalls = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
const presetOps = mutateCalls.flatMap((call) => call.ops)
const presetSet = presetOps.find((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['defaults', 'preset']))
const paramsSet = presetOps.find((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['defaults', 'params']))
if (presetSet === undefined || presetSet.value !== 'precise'
  || paramsSet === undefined || paramsSet.value.temperature !== 0.2 || paramsSet.value.topP !== 0.9 || paramsSet.value.topK !== 20) {
  console.error('smoke: applying the precise preset must write defaults.preset/defaults.params (design §3) — got ' + JSON.stringify(presetOps))
  process.exit(1)
}
writesBefore = writeCalls.length
const defaultTempField = paramFieldInput(presetsTree, 'temperature', 'defaults')
if (defaultTempField === undefined) {
  console.error('smoke: default parameter controls missing from the presets panel')
  process.exit(1)
}
typeParamField(defaultTempField.entry, 'temperature', '0.', 'defaults')
if (writeCalls.length !== writesBefore) {
  console.error('smoke: typing "0." in a default param must not write')
  process.exit(1)
}
const typedDefault = typeParamField(defaultTempField.entry, 'temperature', '0.8', 'defaults')
if (writeCalls.length !== writesBefore) {
  console.error('smoke: typing "0.8" in a default param must not write before blur/Enter')
  process.exit(1)
}
typedDefault.input.props.onBlur()
await effectsRan()
mutateCalls = writeCalls.slice(writesBefore).filter((call) => call.method === 'mutate')
const customPreset = mutateCalls.flatMap((call) => call.ops)
  .find((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['defaults', 'preset']))
const customParams = mutateCalls.flatMap((call) => call.ops)
  .find((op) => op.op === 'set' && JSON.stringify(op.path) === JSON.stringify(['defaults', 'params']))
if (customPreset === undefined || customPreset.value !== 'custom' || customParams === undefined || customParams.value.temperature !== 0.8) {
  console.error('smoke: editing a default parameter must switch to custom + write defaults.params — got ' + JSON.stringify(mutateCalls) + ' writes=' + JSON.stringify(writeCalls.slice(writesBefore)))
  process.exit(1)
}
writesBefore = writeCalls.length
const escapedDefault = typeParamField(defaultTempField.entry, 'temperature', '1.1', 'defaults')
escapedDefault.input.props.onKeyDown({ key: 'Escape', preventDefault() {} })
await effectsRan()
if (writeCalls.length !== writesBefore) {
  console.error('smoke: Escape in a default param must not write')
  process.exit(1)
}
writesBefore = writeCalls.length
const invalidDefault = typeParamField(defaultTempField.entry, 'temperature', 'abc', 'defaults')
invalidDefault.input.props.onBlur()
await effectsRan()
if (writeCalls.length !== writesBefore) {
  console.error('smoke: invalid default param must not write')
  process.exit(1)
}
const invalidDefaultTree = rerenderParamField(defaultTempField.entry, 'temperature', 'defaults')
const invalidDefaultInput = collectMatching(invalidDefaultTree, (node) => node.$$ === 'input')[0]
if (invalidDefaultInput.props['aria-invalid'] !== true || !spanOf(invalidDefaultTree).includes('请输入有效数字')) {
  console.error('smoke: invalid default param must set aria-invalid + inline error — got ' + spanOf(invalidDefaultTree))
  process.exit(1)
}

// ── 2s-2. 写失败：Toast + 回读宿主（UI 回滚）────────────────────────────────
{
  const originalUpdate = HOST_FACES.remoteSettings.update
  const originalDescribe = API.settings.describe
  let describeCalls = 0
  API.settings.describe = async (...args) => { describeCalls += 1; return originalDescribe(...args) }
  HOST_FACES.remoteSettings.update = async () => ({ ok: false, error: { message: '模拟写入失败' } })
  const failPage = await readPage()
  await effectsRan()
  const describeBeforeClick = describeCalls
  const failWbEntry = findComponent(failPage, 'ModelWorkbench')
  resetHooks('ModelWorkbench')
  const failWbTree = failWbEntry[1](failWbEntry[2])
  const failOpen = collectMatching(failWbTree, (node) => node.$$ === 'button' && node.props?.['data-model-open'] === 'demo/m2')[0]
  failOpen.props.onClick({ stopPropagation() {} })
  resetHooks('ModelWorkbench')
  const failWbAfterOpen = failWbEntry[1](failWbEntry[2])
  const failDetailEntry = findComponent(failWbAfterOpen, 'ModelDetail')
  resetHooks('ModelDetail')
  const failDetailTree = failDetailEntry[1](failDetailEntry[2])
  const failImageSelect = collectMatching(failDetailTree, (node) => node.$$ === 'select' && node.props?.['data-detail-image'] !== undefined)[0]
  failImageSelect.props.onChange({ target: { value: 'image' } })
  await sleep(30)
  API.settings.describe = originalDescribe
  HOST_FACES.remoteSettings.update = originalUpdate
  if (describeCalls <= describeBeforeClick) {
    console.error('smoke: failed write must re-read the host projection (UI rollback), but describe was not called again')
    process.exit(1)
  }
  uxPage = await readPage()
  const failToast = collectMatching(uxPage, (node) => node.$$ === 'component' && node.tag?.name === 'Toast')[0]
  if (failToast === undefined || !String(failToast.props.message || '').includes('模拟写入失败')) {
    console.error('smoke: failed write must surface a red Toast with the host error text — got ' + JSON.stringify(failToast?.props))
    process.exit(1)
  }
  const rollbackEntry = findComponent(uxPage, 'ModelWorkbench')
  resetHooks('ModelWorkbench')
  const rollbackTree = rollbackEntry[1](rollbackEntry[2])
  const rollbackDetailEntry = findComponent(rollbackTree, 'ModelDetail')
  resetHooks('ModelDetail')
  const rollbackDetailTree = rollbackDetailEntry[1](rollbackDetailEntry[2])
  const rollbackImage = collectMatching(rollbackDetailTree, (node) => node.$$ === 'select' && node.props?.['data-detail-image'] !== undefined)[0]
  if (rollbackImage === undefined || rollbackImage.props.value !== 'image') {
    console.error('smoke: failed image write must roll the control back to the host projection (image still on) — got ' + JSON.stringify(rollbackImage?.props?.value))
    process.exit(1)
  }
}

// ── 2t. 端点 404 降级：catalog 继续可用 + 诊断标注降级 ───────────────────────
sandbox.fetch = async (url) => (url === '/reasoning-level-models'
  ? { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  : { ok: true, status: 200, json: async () => STATS_FIXTURE })
stores.delete('ReasoningPage')
stores.delete('ModelWorkbench')
const fallbackPage = await readPage()
const fallbackEntry = findComponent(fallbackPage, 'ModelWorkbench')
if (fallbackEntry === undefined) {
  console.error('smoke: workbench must still render when /reasoning-level-models is unavailable')
  process.exit(1)
}
resetHooks('ModelWorkbench')
const fallbackWb = fallbackEntry[1](fallbackEntry[2])
const fallbackWbText = spanOf(fallbackWb)
if (!fallbackWbText.includes('模型信息端点不可用') || !fallbackWbText.includes('demo/m1')) {
  console.error('smoke: endpoint fallback must show a degraded notice and keep catalog rows — got ' + fallbackWbText.slice(0, 400))
  process.exit(1)
}
const fallbackDiagEntry = findComponent(fallbackPage, 'DiagnosticsPanel')
resetHooks('DiagnosticsPanel')
const fallbackDiagTree = fallbackDiagEntry[1](fallbackDiagEntry[2])
const fallbackDiagText = spanOf(fallbackDiagTree)
const fallbackDiagChips = collectMatching(fallbackDiagTree, (node) => node.$$ === 'component' && node.tag?.name === 'LevelChip')
  .map((node) => node.props.label)
if (!fallbackDiagText.includes('模型信息: 不可用')
  || !fallbackDiagText.includes('端点不可用，使用内置注册表降级')
  || !fallbackDiagChips.includes('降级到会话模型目录')) {
  console.error('smoke: diagnostics must label the registry/endpoint fallback when the endpoint is down — got ' + fallbackDiagText.slice(0, 400) + ' chips=' + JSON.stringify(fallbackDiagChips))
  process.exit(1)
}
// 2t-2（隔离实例实测）：endpoint 404 + catalog 返回 0 模型 → 必须收尾为空态，不得永久 loading。
const originalModelsLoader = API.llm.models
API.llm.models = async () => ({ result: { ok: true, value: { groups: [] } } })
stores.delete('ReasoningPage')
stores.delete('ModelWorkbench')
const emptyCatalogPage = await readPage()
const emptyWbEntry = findComponent(emptyCatalogPage, 'ModelWorkbench')
if (emptyWbEntry === undefined) {
  console.error('smoke: workbench must render with an empty catalog + endpoint 404')
  process.exit(1)
}
resetHooks('ModelWorkbench')
const emptyWbTree = emptyWbEntry[1](emptyWbEntry[2])
const emptyStates = collectMatching(emptyWbTree, (node) => node.$$ === 'component' && node.tag?.name === 'EmptyState')
const emptyLoading = collectMatching(emptyWbTree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rl-loading'))
if (!emptyStates.some((node) => node.props.title === '暂无可用模型')) {
  console.error('smoke: empty catalog + 404 endpoint must end in an empty state — got ' + JSON.stringify(emptyStates.map((node) => node.props)))
  process.exit(1)
}
if (emptyLoading.length > 0) {
  console.error('smoke: workbench must not stay in loading after both model sources settled empty')
  process.exit(1)
}
API.llm.models = originalModelsLoader

// ── 2u. T-F2：端点 15s 超时 → AbortController.abort → catalog 降级收尾 ─────────
// 不真等 15s：替换 window.setTimeout 捕获 15000ms 回调，fetch 桩在 abort 时 reject。
{
  const timeoutOriginalFetch = sandbox.fetch
  const timeoutOriginalAbort = sandbox.AbortController
  const timeoutOriginalSetTimeout = sandbox.window.setTimeout
  const timeoutOriginalClearTimeout = sandbox.window.clearTimeout
  let timeoutCallback = null
  let timeoutDelay = 0
  let abortCalls = 0
  let endpointFetches = 0
  class TimeoutAbortController {
    constructor() {
      const listeners = []
      this.aborted = false
      this.signal = {
        aborted: false,
        addEventListener(type, handler) { if (type === 'abort') listeners.push(handler) },
        removeEventListener(type, handler) {
          const index = listeners.indexOf(handler)
          if (index >= 0) listeners.splice(index, 1)
        },
      }
      this.listeners = listeners
    }
    abort() {
      if (this.aborted) return
      this.aborted = true
      abortCalls += 1
      this.signal.aborted = true
      for (const listener of [...this.listeners]) listener()
    }
  }
  sandbox.AbortController = TimeoutAbortController
  sandbox.window.setTimeout = (fn, ms) => {
    if (ms === 15000) { timeoutCallback = fn; timeoutDelay = ms; return 9001 }
    return timeoutOriginalSetTimeout(fn, ms)
  }
  sandbox.window.clearTimeout = (id) => { if (id !== 9001) timeoutOriginalClearTimeout(id) }
  sandbox.fetch = (url, init) => {
    if (url === '/reasoning-level-models') {
      endpointFetches += 1
      return new Promise((resolve, reject) => {
        if (init !== undefined && init.signal !== undefined && typeof init.signal.addEventListener === 'function') {
          init.signal.addEventListener('abort', () => reject(new Error('aborted: timeout')))
        }
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => STATS_FIXTURE })
  }
  stores.delete('ReasoningPage')
  stores.delete('ModelWorkbench')
  await readPage()
  await effectsRan()
  if (timeoutCallback === null || timeoutDelay !== 15000) {
    console.error('smoke: model-info endpoint must arm a 15000ms AbortController timeout — delay=' + timeoutDelay)
    process.exit(1)
  }
  timeoutCallback()
  await effectsRan()
  await sleep(10)
  if (abortCalls === 0) {
    console.error('smoke: 15s timeout must call AbortController.abort()')
    process.exit(1)
  }
  const timeoutPage = await readPage()
  const timeoutWbEntry = findComponent(timeoutPage, 'ModelWorkbench')
  if (timeoutWbEntry === undefined) {
    console.error('smoke: workbench must render after the endpoint timeout falls back to catalog')
    process.exit(1)
  }
  resetHooks('ModelWorkbench')
  const timeoutWbTree = timeoutWbEntry[1](timeoutWbEntry[2])
  const timeoutText = spanOf(timeoutWbTree)
  if (!timeoutText.includes('模型信息端点不可用') || !timeoutText.includes('demo/m1')) {
    console.error('smoke: timeout fallback must show the degraded notice and catalog rows — got ' + timeoutText.slice(0, 400))
    process.exit(1)
  }
  if (collectMatching(timeoutWbTree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rl-loading')).length > 0) {
    console.error('smoke: timeout fallback must not keep the loading state')
    process.exit(1)
  }
  if (endpointFetches === 0) {
    console.error('smoke: timeout test must actually call the model-info endpoint')
    process.exit(1)
  }
  sandbox.fetch = timeoutOriginalFetch
  sandbox.AbortController = timeoutOriginalAbort
  sandbox.window.setTimeout = timeoutOriginalSetTimeout
  sandbox.window.clearTimeout = timeoutOriginalClearTimeout
}

// ── 2v. T-F3：真实容器宽度驱动工作台布局（559 → narrow/inline；1200 → wide/aside）──
// 给 host 根节点桩 getBoundingClientRect（模拟浏览器已布局的 DOM），让组件自己的
// 挂载测量 + ResizeObserver 路径真实执行；不是手写窄布局 markup。
{
  const measuredOriginalResizeObserver = sandbox.ResizeObserver
  const observedNodes = []
  sandbox.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(node) {
      observedNodes.push(node)
      if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
        this.callback([{ target: node, contentRect: node.getBoundingClientRect() }], this)
      }
    }
    disconnect() {}
  }
  const renderMeasured = (width) => {
    measuredRefWidth = width
    resetHooks('ModelWorkbench')
    return realWorkbenchFn({ ...realWorkbenchProps, narrow: false })
  }
  const rootClassOf = (tree) => collectMatching(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes('rl-workbench'))[0]?.props.className || ''
  stores.delete('ModelWorkbench')
  let measuredTree = renderMeasured(559)
  await effectsRan()
  measuredTree = renderMeasured(559)
  await effectsRan()
  const narrowRoot = rootClassOf(measuredTree)
  if (!narrowRoot.split(/\s+/).includes('rl-workbench-narrow') || !narrowRoot.split(/\s+/).includes('rl-workbench-single')) {
    console.error('smoke: T-F3 559px container must render the workbench single-column + narrow — got ' + JSON.stringify(narrowRoot))
    process.exit(1)
  }
  const narrowOpen = collectMatching(measuredTree, (node) => node.$$ === 'button' && node.props?.['data-model-open'] === 'demo/m2')[0]
  narrowOpen.props.onClick({ stopPropagation() {} })
  measuredTree = renderMeasured(559)
  await effectsRan()
  const inlineDetails = collectMatching(measuredTree, (node) => node.$$ === 'component' && node.tag?.name === 'ModelDetail' && node.props?.inline === true)
  if (inlineDetails.length !== 1 || collectMatching(measuredTree, (node) => node.$$ === 'aside').length !== 0) {
    console.error('smoke: T-F3 559px container must inline the detail and omit the aside')
    process.exit(1)
  }
  measuredTree = renderMeasured(1200)
  await effectsRan()
  measuredTree = renderMeasured(1200)
  await effectsRan()
  const wideRoot = rootClassOf(measuredTree)
  if (wideRoot.split(/\s+/).includes('rl-workbench-narrow') || wideRoot.split(/\s+/).includes('rl-workbench-single')) {
    console.error('smoke: T-F3 1200px container must return to the wide two-column workbench — got ' + JSON.stringify(wideRoot))
    process.exit(1)
  }
  if (collectMatching(measuredTree, (node) => node.$$ === 'aside').length === 0
    || collectMatching(measuredTree, (node) => node.$$ === 'component' && node.tag?.name === 'ModelDetail' && node.props?.inline !== true).length === 0) {
    console.error('smoke: T-F3 1200px container must render the detail as a right-hand aside')
    process.exit(1)
  }
  if (observedNodes.length === 0) {
    console.error('smoke: T-F3 must exercise the component ResizeObserver/measurement path')
    process.exit(1)
  }
  measuredRefWidth = 0
  sandbox.ResizeObserver = measuredOriginalResizeObserver
}

// ── 3. MAINT-025 (b)：写路径经真实适配层驱动契约桩。旧冒烟从不触发写路径，
// 契约桩不承重 = 防护形同虚设；此步让 update/mutate 的元数/形状校验真实执行
// （调用形状 = 页面 change() 的实际形状，锚定 lib/client.js:766-772——页面不传
// expectedRevision，由适配层按三参契约补位）。
await pageElement.props.api.settings.update({ ns: 'llm-reasoning', patch: { level: 'high' } })
await pageElement.props.api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', 'demo/m1'] }] })

// ── 4. 无 document 环境：ensureStyles 静默跳过，节点树照常完整渲染 ─────────────
// （client-smoke 硬约束；用独立 vm 上下文重新加载模块，避免主沙箱的 document 桩。）
const noDocSandbox = {
  window: {
    __ModuleLoader__: { load(def) { noDocSandbox.__loaded = def } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  },
  fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  AbortController,
}
vm.runInNewContext(source, noDocSandbox, { filename: 'lib/client.js' })
const noDocClient = noDocSandbox.__loaded
if (!noDocClient || noDocClient.id !== 'dsh-reasoning-level') {
  console.error('smoke: client must load without a document global')
  process.exit(1)
}
const noDocExports = noDocClient.factory((name) => {
  if (name === 'react') return react
  throw new Error('client required unexpected module: ' + name)
})
const noDocRegistered = []
noDocExports.apply({
  get: (name) => (name === 'remote.settings' ? HOST_FACES.remoteSettings
    : name === 'remote.session' ? HOST_FACES.remoteSession
    : name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
  slots: {
    inject: (_slot, provider) => provider(),
    register: (meta, render) => { noDocRegistered.push({ meta, render }); return () => {} },
  },
})
stores.clear()
const noDocPage = noDocRegistered[0].render({})
resetHooks('ReasoningPage'); noDocPage.tag(noDocPage.props); await effectsRan()
resetHooks('ReasoningPage'); const noDocTree = noDocPage.tag(noDocPage.props); await effectsRan()
const noDocComponents = []
collectComponents(noDocTree, noDocComponents)
for (const name of ['PageHeader', 'TabBar', 'ModelWorkbench', 'StatsPanel', 'ModelDefaults']) {
  if (!noDocComponents.some(([componentName]) => componentName === name)) {
    console.error('smoke: no-document tree must still render ' + name + ' — got ' + JSON.stringify(noDocComponents.map(([n]) => n)))
    process.exit(1)
  }
}

for (const timer of timers) clearTimeout(timer)
console.log('client-smoke: OK — ' + rendered + ' components rendered through loading and loaded paths; 1 settings section; 7 legacy write entries + UX-004 write paths (reasoning select / image toggle / modelParams set+follow / reset-model unsets / preset defaults / default-param custom) + 3-arg update/mutate contract stubs; UX-004 four views, aria-selected tabs, Esc detail close, narrow inline detail, endpoint-primary + 404 fallback + 15s timeout abort + empty-catalog empty state (no permanent loading), container-width 559/1200 layout, detail param coverage (topP/topK/maxTokens + 生效/预留 reasons), arrow matrix, R2 commit-on-blur/Enter + Escape/invalid no-write + R2b hidden router (15 rows/7 providers, 0 router terms, writeKeys sync, row source + dimension detail, undo), no-document render; FEAT-004 (search add / support matrix / stats toolbar / undo / persisted tri-state) + blocked attribution + FEAT-005 level comparison + R0 fixes asserted')
