/**
 * N2 行为测试（// TDD-GUARD-N2，原 TDD-FAILS-UNTIL-N2，已修复转绿，回归即红）。
 *
 * 背景（R1 §3 残留 N2）：probeAll 起始应重置 probeSummaryOk——现状只在失败路径
 * 调用 setProbeSummaryOk(false)，成功路径不重置；一轮失败后重跑成功，摘要仍显示
 * 红色。本用例用与 scripts/client-smoke.mjs 同构的方式（VM + 最小 React 桩）驱动
 * 真实 lib/client.js：先跑一轮 apply 失败（摘要红），再跑一轮 apply 成功，断言
 * 摘要恢复绿色。
 *
 * 边界说明：scripts/ 不在 QA 修改边界内，N2 测试在 test/ 内自建同构 harness，
 * 不修改 client-smoke.mjs（该脚本已覆盖"渲染不崩溃"，本测试只补状态重置语义）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 最小 React 桩：按 (组件名, hook 序) 寻址状态，跨渲染存活（与 smoke 同构）────
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

// ── 宿主桩：第一轮 probe/apply 失败（error: 'boom'），第二轮成功（writes: 1）──
const applyCalls = []
const API = {
  settings: {
    describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'llm-reasoning', value: { enabled: true, level: 'high', models: {}, purposes: {}, syncDefaultAgent: false, statsPublic: false } }] } } }),
    update: async () => ({ result: { ok: true } }),
    mutate: async () => ({ result: { ok: true } }),
  },
  llm: {
    models: async () => ({ result: { ok: true, value: { groups: [{ id: 'demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }] }] } } }),
  },
}
const fetchStub = async (url) => {
  if (url.includes('/probe/apply')) {
    applyCalls.push(url)
    if (applyCalls.length === 1) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    return { ok: true, status: 200, json: async () => ({ writes: 1 }) }
  }
  if (url.includes('/probe')) return { ok: true, status: 200, json: async () => ({ provider: 'demo', model: 'm1', working: ['low'], rejected: [], blocked: [] }) }
  return { ok: true, status: 200, json: async () => ({ since: Date.now(), totalCalls: 0, models: {}, recent: [], blacklist: {} }) }
}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) { sandbox.__loaded = def },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  },
  fetch: fetchStub,
  // VM 新上下文无 Node 全局；client.js probeAll 直接调用 AbortController
  AbortController,
}

function collectComponents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && typeof node.tag === 'function' && node.tag.name && !into.some(([n]) => n === node.tag.name)) {
    into.push([node.tag.name, node.tag, node.props])
  }
  for (const child of node.children ?? []) collectComponents(child, into)
  collectComponents(node.props?.children, into)
}

function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.$$ === 'button' && (node.children ?? []).includes(label) && typeof node.props?.onClick === 'function') return node
  for (const child of node.children ?? []) { const r = findButton(child, label); if (r) return r }
  return null
}

function findSummary(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  const style = node.props?.style
  if (node.$$ === 'div' && style?.color !== undefined && style.fontSize === '12px' && style.marginTop === '8px') return node
  for (const child of node.children ?? []) { const r = findSummary(child); if (r) return r }
  return null
}

test('(N2) probeAll 重跑成功时摘要恢复绿色 —  // TDD-GUARD-N2', async () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const client = sandbox.__loaded
  assert.ok(client && client.id === 'dsh-reasoning-level', 'client module must load')
  const factoryExports = client.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })

  const registered = []
  const ctx = {
    get: (name) => (name === 'connection' ? { api: API } : name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject: (_slot, provider) => provider(),
      register: (meta, render) => { registered.push({ meta, render }); return () => {} },
    },
  }
  factoryExports.apply(ctx)
  assert.equal(registered.length, 1)
  const pageTag = registered[0].render({}).tag

  // ReasoningPage：loading → loaded，收集子组件
  resetHooks('ReasoningPage'); pageTag({ api: API }); await sleep(5)
  resetHooks('ReasoningPage')
  const pageTree = pageTag({ api: API })
  const components = [['ReasoningPage', pageTag, { api: API }]]
  collectComponents(pageTree, components)
  const statsEntry = components.find(([name]) => name === 'StatsPanel')
  assert.ok(statsEntry, 'StatsPanel must be reachable from the page tree')
  const [, statsFn, statsProps] = statsEntry

  // StatsPanel：loading → loaded（探测目标加载后按钮才可用）
  resetHooks('StatsPanel'); statsFn(statsProps ?? { api: API }); await sleep(5)
  resetHooks('StatsPanel')
  const loadedTree = statsFn(statsProps ?? { api: API })
  const btn1 = findButton(loadedTree, '一键探测全部模型并固化配置')
  assert.ok(btn1, 'probeAll button not found after load')

  // 第一轮：apply 失败 → 摘要红色（这是 N2 场景的前置）
  // 语义色断言随 UX-001 design tokens 同步：不透明 #c62828/#2e7d32 → 半透明变体
  // rgba(198,40,40,0.9)/rgba(46,125,50,0.9)（明暗自适应，语义不变：失败红/成功绿）
  btn1.props.onClick()
  await sleep(50)
  resetHooks('StatsPanel')
  const tree1 = statsFn(statsProps ?? { api: API })
  const summ1 = findSummary(tree1)
  assert.ok(summ1, 'summary element must render after first probe run')
  assert.equal(summ1.props.style.color, 'rgba(198,40,40,0.9)', '前置：失败轮摘要应为红色')

  // 第二轮：apply 成功 → 摘要应为绿色（N2 期望：probeAll 起始重置 probeSummaryOk）
  const btn2 = findButton(tree1, '一键探测全部模型并固化配置')
  assert.ok(btn2)
  btn2.props.onClick()
  await sleep(50)
  resetHooks('StatsPanel')
  const tree2 = statsFn(statsProps ?? { api: API })
  const summ2 = findSummary(tree2)
  assert.ok(summ2, 'summary element must render after second probe run')
  assert.equal(summ2.props.style.color, 'rgba(46,125,50,0.9)', '成功重跑后摘要应为绿色（probeSummaryOk 需在 probeAll 起始重置）')
})
