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

// ── host-side stubs the client touches during render ─────────────────────
const STATS_FIXTURE = {
  since: Date.now(),
  totalCalls: 2,
  models: {
    'demo/m1': {
      calls: 2, efforts: { high: 2 }, reasoningTokens: 12, outputTokens: 34,
      reasoningChars: 0, durationMs: 120, errors: 0, errRate: 0, rejected: [],
    },
  },
  recent: [
    { t: Date.now(), provider: 'demo', model: 'm1', effort: 'high', rt: 12, rc: null, ot: 34, it: 10, duration: 60, finish: 'stop' },
  ],
  blacklist: {},
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
const sandbox = {
  window: {
    __ModuleLoader__: { load(def) { loaded = def } },
    setInterval: () => 0,
    clearInterval: () => {},
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
for (const [name, fn, props] of components) {
  if (typeof fn !== 'function') continue
  await renderTwice(name, fn, props ?? pageElement.props)
  rendered += 1
}
if (rendered < 3) {
  console.error('smoke: expected to exercise at least 3 components (page, defaults, stats), rendered ' + rendered)
  process.exit(1)
}

// ── 3. MAINT-025 (b)：写路径经真实适配层驱动契约桩。旧冒烟从不触发写路径，
// 契约桩不承重 = 防护形同虚设；此步让 update/mutate 的元数/形状校验真实执行
// （调用形状 = 页面 change() 的实际形状，锚定 lib/client.js:766-772——页面不传
// expectedRevision，由适配层按三参契约补位）。
await pageElement.props.api.settings.update({ ns: 'llm-reasoning', patch: { level: 'high' } })
await pageElement.props.api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', 'demo/m1'] }] })

for (const timer of timers) clearTimeout(timer)
console.log('client-smoke: OK — ' + rendered + ' components rendered through loading and loaded paths, 1 settings section registered, write-path contract stubs exercised (3-arg update/mutate)')
