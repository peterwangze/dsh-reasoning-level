/**
 * N2 行为测试（// TDD-GUARD-N2，原 TDD-FAILS-UNTIL-N2，已修复转绿，回归即红）。
 *
 * 背景（R1 §3 残留 N2）：probeAll 起始应重置 probeSummaryOk——现状只在失败路径
 * 调用 setProbeSummaryOk(false)，成功路径不重置；一轮失败后重跑成功，摘要仍显示
 * 红色。本用例用与 scripts/client-smoke.mjs 同构的方式（VM + 最小 React 桩）驱动
 * 真实 lib/client.js：先跑一轮 apply 失败（摘要红），再跑一轮 apply 成功，断言
 * 摘要恢复绿色。
 *
 * UX-003 适配（语义不变，只换驱动路径与断言载体）：
 *  · 探测主按钮按 §3.1 从观测卡上移到页头 PageHeader，故按钮从 PageHeader 的
 *    渲染树里找；点击后重新渲染页面，再把最新 probe props 传给 StatsPanel 读摘要。
 *  · 摘要颜色按 §2.1 迁移到样式表（rl-status-ok / rl-status-bad），断言类名而非
 *    inline style 颜色字符串——失败红/成功绿的语义保持不变。
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
  // UX-003：按钮经 Button 基元（component 元素）渲染；测试遍历未渲染树，故把
  // Button 元素视作可点击按钮（onClick 透传，与原生 button 等义）。
  if (node.$$ === 'component' && node.tag?.name === 'Button'
    && (node.children ?? []).includes(label) && typeof node.props?.onClick === 'function') return node
  for (const child of node.children ?? []) { const r = findButton(child, label); if (r) return r }
  return null
}

/** 页头主操作：渲染 PageHeader（无 hook）后找探测按钮。 */
function findProbeButton(pageTree, label) {
  const components = []
  collectComponents(pageTree, components)
  const header = components.find(([name]) => name === 'PageHeader')
  assert.ok(header, 'PageHeader must be reachable from the page tree')
  return findButton(header[1](header[2]), label)
}

/** 观测卡：从页面树取最新 StatsPanel props 并渲染（StatsPanel 无 hook）。 */
function renderStatsPanel(pageTree) {
  const components = []
  collectComponents(pageTree, components)
  const stats = components.find(([name]) => name === 'StatsPanel')
  assert.ok(stats, 'StatsPanel must be reachable from the page tree')
  return stats[1](stats[2])
}

function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) return node
  for (const child of node.children ?? []) { const r = findByClass(child, className); if (r) return r }
  return findByClass(node.props?.children, className)
}

test('(N2) probeAll 重跑成功时摘要恢复绿色 —  // TDD-GUARD-N2', async () => {
  stores.clear()
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
  const pageProps = { api: API }

  // ReasoningPage：loading → loaded（describe/models/stats effect 解析）
  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage')
  const pageTree = pageTag(pageProps)

  // 第一轮：apply 失败 → 摘要红色（这是 N2 场景的前置）
  const btn1 = findProbeButton(pageTree, '一键探测全部模型并固化配置')
  assert.ok(btn1, 'probeAll button not found in PageHeader after load')
  btn1.props.onClick()
  await sleep(80)

  resetHooks('ReasoningPage')
  const tree1 = pageTag(pageProps)
  const summ1 = findByClass(renderStatsPanel(tree1), 'rl-probe-summary')
  assert.ok(summ1, 'summary element must render after first probe run')
  assert.ok(summ1.props.className.includes('rl-status-bad'), '前置：失败轮摘要应为红色')

  // 第二轮：apply 成功 → 摘要应为绿色（N2 期望：probeAll 起始重置 probeSummaryOk）
  const btn2 = findProbeButton(tree1, '一键探测全部模型并固化配置')
  assert.ok(btn2)
  btn2.props.onClick()
  await sleep(80)

  resetHooks('ReasoningPage')
  const tree2 = pageTag(pageProps)
  const summ2 = findByClass(renderStatsPanel(tree2), 'rl-probe-summary')
  assert.ok(summ2, 'summary element must render after second probe run')
  assert.ok(summ2.props.className.includes('rl-status-ok'), '成功重跑后摘要应为绿色（probeSummaryOk 需在 probeAll 起始重置）')
})
