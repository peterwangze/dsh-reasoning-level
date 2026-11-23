/**
 * FEAT-009 增量探测（客户端面）行为测试。
 *
 * 背景：探测主按钮此前遍历全部 targets 逐个 POST /probe，最后 POST /probe/apply。
 * 增量探测先取 /probe/plan：只实测 probe 列表，skip 列表作为「沿用上次结果」的
 * kept 行并入结果表；计划不可用（网络错误 / 非 2xx / 形状不符）回退全量探测。
 * 另加「全量重探」按钮（force=true）——忽略已有结果、重新实测全部模型。
 *
 * 驱动方式与 test/client-probe-summary.test.mjs 同构：VM + 最小 React 桩执行真实
 * lib/client.js，渲染 PageHeader 找探测按钮、渲染 StatsPanel 读结果表与摘要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PROBE_LABEL = '一键探测思考档位（写回模型能力声明）'
const FORCE_LABEL = '全量重探（忽略已有结果）'

const STATS_FIXTURE = {
  since: Date.now(),
  totalCalls: 0,
  models: {},
  recent: [],
  blacklist: {},
}

function createApi(models) {
  const catalog = Array.isArray(models) ? models : [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]
  return {
    settings: {
      describe: async () => ({
        result: {
          ok: true,
          value: {
            namespaces: [
              { ns: 'llm-reasoning', value: { enabled: true, level: 'high', models: {}, purposes: {}, syncDefaultAgent: false, statsPublic: false } },
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
          value: { groups: [{ id: 'demo', models: catalog }] },
        },
      }),
    },
  }
}

/** 每个用例独立一套 VM + React 桩（hook 槽位按组件名隔离，stores 不跨用例）。 */
function createHarness(planResponse, probeResponse, models) {
  const api = createApi(models)
  const stores = new Map()
  let currentComponent = ''
  let hookIndex = 0
  const slots = () => {
    if (!stores.has(currentComponent)) stores.set(currentComponent, [])
    return stores.get(currentComponent)
  }
  const resetHooks = (name) => {
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
  const calls = []
  const fetchStub = async (url, init) => {
    calls.push({ url, init })
    if (url === '/reasoning-level-stats/probe/plan') return planResponse()
    if (url === '/reasoning-level-stats/probe') {
      // P1-1 回归：允许用例让单个模型探测直接 reject（模拟超时/网络失败）。
      if (typeof probeResponse === 'function') return probeResponse(init)
      let body = {}
      try { body = JSON.parse(init !== undefined && typeof init.body === 'string' ? init.body : '{}') } catch (error) { body = {} }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          provider: body.provider,
          model: body.model,
          key: body.provider + '/' + body.model,
          working: ['low'],
          rejected: [],
          blocked: [],
          persisted: 'pending-apply',
        }),
      }
    }
    if (url === '/reasoning-level-stats/probe/apply') {
      return { ok: true, status: 200, json: async () => ({ writes: 1, outcomes: [], skipped: [] }) }
    }
    return { ok: true, status: 200, json: async () => STATS_FIXTURE }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { sandbox.__loaded = def } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    fetch: fetchStub,
    // VM 新上下文无 Node 全局；runProbe 直接调用 AbortController
    AbortController,
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const client = sandbox.__loaded
  assert.ok(client && client.id === 'dsh-reasoning-level', 'client module must load')
  const factoryExports = client.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })
  const registered = []
  const ctx = {
    get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject: (_slot, provider) => provider(),
      register: (meta, render) => { registered.push({ meta, render }); return () => {} },
    },
  }
  factoryExports.apply(ctx)
  assert.equal(registered.length, 1)
  const pageTag = registered[0].render({}).tag
  const pageProps = { api }
  return { pageTag, pageProps, calls, resetHooks }
}

/** ReasoningPage：loading → loaded（describe/models/stats effect 解析）。 */
async function loadPage(h) {
  h.resetHooks('ReasoningPage')
  h.pageTag(h.pageProps)
  await sleep(10)
  h.resetHooks('ReasoningPage')
  h.pageTag(h.pageProps)
  await sleep(10)
  h.resetHooks('ReasoningPage')
  return h.pageTag(h.pageProps)
}

function collectComponents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && typeof node.tag === 'function' && node.tag.name && !into.some(([n]) => n === node.tag.name)) {
    into.push([node.tag.name, node.tag, node.props])
  }
  for (const child of node.children ?? []) collectComponents(child, into)
}

function findComponent(tree, name) {
  const list = []
  collectComponents(tree, list)
  return list.find(([componentName]) => componentName === name)
}

function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.$$ === 'button' && (node.children ?? []).includes(label) && typeof node.props?.onClick === 'function') return node
  // 按钮经 Button 基元（component 元素）渲染；测试遍历未渲染树，故把 Button 元素
  // 视作可点击按钮（onClick 透传，与原生 button 等义）。
  if (node.$$ === 'component' && node.tag?.name === 'Button'
    && (node.children ?? []).includes(label) && typeof node.props?.onClick === 'function') return node
  for (const child of node.children ?? []) { const r = findButton(child, label); if (r) return r }
  return null
}

function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) return node
  for (const child of node.children ?? []) { const r = findByClass(child, className); if (r) return r }
  return null
}

function collectByClass(node, className, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) into.push(node)
  for (const child of node.children ?? []) collectByClass(child, className, into)
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** 页头主操作：渲染 PageHeader（无 hook）后找探测按钮。 */
function findProbeButton(pageTree) {
  const header = findComponent(pageTree, 'PageHeader')
  assert.ok(header, 'PageHeader must be reachable from the page tree')
  return findButton(header[1](header[2]), PROBE_LABEL)
}

/** 观测卡：从页面树取最新 StatsPanel props 并渲染（StatsPanel 只有 useState）。 */
function renderStatsPanel(h, pageTree) {
  const stats = findComponent(pageTree, 'StatsPanel')
  assert.ok(stats, 'StatsPanel must be reachable from the page tree')
  h.resetHooks('StatsPanel')
  return stats[1](stats[2])
}

function probeBodies(calls) {
  return calls
    .filter((call) => call.url === '/reasoning-level-stats/probe')
    .map((call) => JSON.parse(call.init !== undefined && typeof call.init.body === 'string' ? call.init.body : '{}'))
}

function applyBodies(calls) {
  return calls
    .filter((call) => call.url === '/reasoning-level-stats/probe/apply')
    .map((call) => JSON.parse(call.init !== undefined && typeof call.init.body === 'string' ? call.init.body : '{}'))
}

function planBodies(calls) {
  return calls
    .filter((call) => call.url === '/reasoning-level-stats/probe/plan')
    .map((call) => JSON.parse(call.init !== undefined && typeof call.init.body === 'string' ? call.init.body : '{}'))
}

/** 探测结果表（rl-probe-table）里的模型列单元格文本。 */
function probeKeyCells(statsTree) {
  const table = findByClass(statsTree, 'rl-probe-table')
  assert.ok(table, 'probe results table must render')
  const cells = []
  collectByClass(table, 'rl-cell-key', cells)
  return cells.map(textOf)
}

const settledEntry = (working) => ({ working, rejected: [], blocked: [], persisted: 'converged' })

test('(FEAT-009/A) 增量探测：只实测 plan.probe，skip 行沿用上次结果', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      probe: [{ provider: 'demo', model: 'm2', key: 'demo/m2', reason: 'never-probed' }],
      skip: [{ provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'settled', entry: settledEntry(['low']) }],
      total: 2,
      force: false,
    }),
  }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button, 'probe-all button must render in PageHeader')
  button.props.onClick()
  await sleep(80)

  // 只对 m2 发过 /probe（m1 沿用上次结果，不重复实测）
  assert.deepEqual(probeBodies(h.calls).map((body) => body.provider + '/' + body.model), ['demo/m2'])
  // apply 只发送本轮实测结果（kept 行不发送）
  const applied = applyBodies(h.calls)
  assert.equal(applied.length, 1, 'apply must be called exactly once')
  assert.deepEqual(applied[0].results.map((row) => row.key), ['demo/m2'])

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const cells = probeKeyCells(statsTree)
  assert.equal(cells.length, 2, 'both the kept row and the measured row must render')
  assert.ok(cells.some((text) => text.includes('demo/m1') && text.includes('沿用上次结果')),
    'kept row must carry the kept tag — got ' + JSON.stringify(cells))
  assert.ok(cells.some((text) => text.includes('demo/m2') && !text.includes('沿用上次结果')),
    'measured row must not carry the kept tag — got ' + JSON.stringify(cells))

  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary, 'summary must render after incremental probe')
  const summaryText = textOf(summary)
  assert.ok(summaryText.includes('本次增量实测 1/2'), 'summary must report 1/2 measured — got ' + summaryText)
  assert.ok(summaryText.includes('沿用上次探测'), 'summary must explain the skipped models — got ' + summaryText)
})

test('(FEAT-009/B) 全部已固化：零实测、零 apply，摘要说明未发起实测', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      probe: [],
      skip: [
        { provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'settled', entry: settledEntry(['low']) },
        { provider: 'demo', model: 'm2', key: 'demo/m2', reason: 'settled', entry: settledEntry(['high']) },
      ],
      total: 2,
      force: false,
    }),
  }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  assert.equal(probeBodies(h.calls).length, 0, 'no model may be measured when every target is settled')
  assert.equal(applyBodies(h.calls).length, 0, 'apply must not run when nothing was measured')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const cells = probeKeyCells(statsTree)
  assert.equal(cells.length, 2, 'both settled rows must render as kept rows')
  assert.ok(cells.every((text) => text.includes('沿用上次结果')), 'every settled row must carry the kept tag — got ' + JSON.stringify(cells))

  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary)
  assert.ok(textOf(summary).includes('全部 2 个模型均已有上次探测结果'), 'summary must state nothing was measured — got ' + textOf(summary))
})

test('(FEAT-009/C) 计划请求失败：回退全量探测', async () => {
  const h = createHarness(() => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m1', 'demo/m2'], 'plan failure must fall back to probing every target')
  assert.equal(applyBodies(h.calls).length, 1)

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary)
  const summaryText = textOf(summary)
  assert.ok(summaryText.includes('探测完成：2 个模型'), 'fallback must keep the legacy probeDone summary — got ' + summaryText)
  assert.ok(!summaryText.includes('本次增量实测'), 'fallback must not claim incremental semantics — got ' + summaryText)
})

test('(FEAT-009/C2) 计划响应形状不符：回退全量探测', async () => {
  const h = createHarness(() => ({ ok: true, status: 200, json: async () => ({ total: 2 }) }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m1', 'demo/m2'], 'malformed plan must fall back to probing every target')
})

test('(FEAT-009/D) 全量重探：force=true 且实测全部模型', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      probe: [
        { provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'forced' },
        { provider: 'demo', model: 'm2', key: 'demo/m2', reason: 'forced' },
      ],
      skip: [],
      total: 2,
      force: true,
    }),
  }))
  const pageTree = await loadPage(h)
  const statsTree = renderStatsPanel(h, pageTree)
  const forceButton = findButton(statsTree, FORCE_LABEL)
  assert.ok(forceButton, 'force re-probe button must render in the StatsPanel toolbar')
  forceButton.props.onClick()
  await sleep(80)

  const plans = planBodies(h.calls)
  assert.equal(plans.length, 1, 'force re-probe must still consult the plan endpoint once')
  assert.equal(plans[0].force, true, 'force re-probe must send force=true')
  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m1', 'demo/m2'], 'force re-probe must measure every target')
})

test('(FEAT-009/E) 探测失败行不进入 /probe/apply（P1 回归）', async () => {
  // 单模型目录 + probe:[m1]/skip:[] 的计划是「完全覆盖」的合法计划，
  // 确保本用例走的是「计划被采用、m1 实测失败」路径（而非覆盖率不足的全量回退）。
  const h = createHarness(
    () => ({
      ok: true,
      status: 200,
      json: async () => ({
        probe: [{ provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'never-probed' }],
        skip: [],
        total: 1,
        force: false,
      }),
    }),
    // 单模型探测直接 reject（模拟 95s 超时 / 连接失败）
    () => Promise.reject(new Error('probe down')),
    [{ id: 'm1', name: 'M1' }],
  )
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  assert.equal(probeBodies(h.calls).length, 1, 'the failed model must still be attempted once')
  assert.equal(applyBodies(h.calls).length, 0, 'failed probe rows must not be sent to /probe/apply')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const cells = probeKeyCells(statsTree)
  assert.ok(cells.some((text) => text.includes('demo/m1')), 'failed row must still render in the results table — got ' + JSON.stringify(cells))
  const table = findByClass(statsTree, 'rl-probe-table')
  assert.ok(table, 'probe results table must render')
  assert.ok(textOf(table).includes('探测请求失败'), 'failed row must show the probe-failure text — got ' + textOf(table))
  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary === null || !textOf(summary).includes('写回'),
    'summary must not report a probeDone write count — got ' + (summary === null ? '(no summary)' : textOf(summary)))
})

test('(FEAT-009/E2) 服务端 2xx 带 error 的探测行同样不进入 apply（P1 回归）', async () => {
  const h = createHarness(
    () => ({
      ok: true,
      status: 200,
      json: async () => ({
        probe: [{ provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'never-probed' }],
        skip: [],
        total: 1,
        force: false,
      }),
    }),
    // 2xx 但响应体带 error（上游网关失败）：与 fetch 失败同义，不参与固化
    () => ({
      ok: true,
      status: 200,
      json: async () => ({ provider: 'demo', model: 'm1', key: 'demo/m1', error: 'upstream 502', working: [], rejected: [], blocked: [] }),
    }),
    [{ id: 'm1', name: 'M1' }],
  )
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  assert.equal(applyBodies(h.calls).length, 0, 'a 2xx row carrying an error field must not be sent to /probe/apply')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const table = findByClass(statsTree, 'rl-probe-table')
  assert.ok(table, 'probe results table must render')
  assert.ok(textOf(table).includes('upstream 502'), 'the server-side error must surface in the results table — got ' + textOf(table))
})

test('(FEAT-009/F) 计划网络失败：回退全量探测（P2-3）', async () => {
  const h = createHarness(() => Promise.reject(new Error('network')))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m1', 'demo/m2'], 'plan network failure must fall back to probing every target')
  assert.equal(applyBodies(h.calls).length, 1, 'fallback success rows must still be applied')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary)
  const summaryText = textOf(summary)
  assert.ok(summaryText.includes('探测完成：2 个模型'), 'fallback must keep the legacy probeDone summary — got ' + summaryText)
  assert.ok(!summaryText.includes('本次增量实测'), 'fallback must not claim incremental semantics — got ' + summaryText)
})

test('(FEAT-009/G) 计划元素非法但覆盖完整：丢弃非法元素后仍采用计划（P3-3）', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      // null 与空 model 应被丢弃；剩余 probe m2 + skip m1 覆盖全部 targets → 计划仍采用
      // （若未做元素校验，null 进覆盖循环会抛 TypeError 并被外层 catch 吞成全量回退）
      probe: [null, { provider: 'demo', model: '' }, { provider: 'demo', model: 'm2', key: 'demo/m2', reason: 'never-probed' }],
      skip: [{ provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'settled', entry: settledEntry(['low']) }],
      total: 3,
      force: false,
    }),
  }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m2'], 'invalid plan elements must be dropped and the covered plan adopted')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const cells = probeKeyCells(statsTree)
  assert.equal(cells.length, 2, 'both rows must render')
  assert.ok(cells.some((text) => text.includes('demo/m1') && text.includes('沿用上次结果')),
    'skip row must render as kept — got ' + JSON.stringify(cells))
  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary)
  assert.ok(textOf(summary).includes('本次增量实测 1/2'), 'incremental summary must use the attempt count — got ' + textOf(summary))
})

test('(FEAT-009/H) 连点两次只启动一轮探测（P3-1）', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      probe: [
        { provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'never-probed' },
        { provider: 'demo', model: 'm2', key: 'demo/m2', reason: 'never-probed' },
      ],
      skip: [],
      total: 2,
      force: false,
    }),
  }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  // 同步连点：第二次调用时 React 尚未重渲染，只有 probingRef 同步守卫能拦住
  button.props.onClick()
  button.props.onClick()
  await sleep(80)
  assert.equal(planBodies(h.calls).length, 1, 'a second click before re-render must not start another round')
  assert.equal(probeBodies(h.calls).length, 2, 'each target must still be measured exactly once')
})

test('(FEAT-009/G2) 计划覆盖不全：整份作废并回退全量探测（P3-2）', async () => {
  const h = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      // 只覆盖 m1、缺 m2 → 整份计划作废，回退全量
      probe: [{ provider: 'demo', model: 'm1', key: 'demo/m1', reason: 'never-probed' }],
      skip: [],
      total: 1,
      force: false,
    }),
  }))
  const pageTree = await loadPage(h)
  const button = findProbeButton(pageTree)
  assert.ok(button)
  button.props.onClick()
  await sleep(80)

  const measured = probeBodies(h.calls).map((body) => body.provider + '/' + body.model).sort()
  assert.deepEqual(measured, ['demo/m1', 'demo/m2'], 'partially covered plan must fall back to probing every target')

  h.resetHooks('ReasoningPage')
  const statsTree = renderStatsPanel(h, h.pageTag(h.pageProps))
  const summary = findByClass(statsTree, 'rl-probe-summary')
  assert.ok(summary)
  const summaryText = textOf(summary)
  assert.ok(summaryText.includes('探测完成：2 个模型'), 'invalid plan must keep the legacy probeDone summary — got ' + summaryText)
  assert.ok(!summaryText.includes('本次增量实测'), 'invalid plan must not claim incremental semantics — got ' + summaryText)
})

