/**
 * FEAT-004 ⑦ 判别测试：探测 failure 归因（设计 §6.2 / §10.1）。
 *
 * 覆盖（任一被破坏即红）：
 *  ① blocked 档位的 code/message/kind 进入 `blockedReasons`，并随 lastProbe 落盘；
 *  ② rejected 档位（UNSUPPORTED_REASONING_EFFORT）不进入 blockedReasons；
 *  ③ 旧 lastProbe（无 blockedReasons 字段）客户端渲染不崩，且按「未知原因」降级；
 *  ④ 官方适配器结局 `skipped:official-adapter`：判据可判定（provider 白名单 +
 *     llm-deepseek 设置节已注册 + 非 pi-ai 配置），并经 /probe/apply 收口不降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { makeCtx, mount, callRoute } from './harness.mjs'
import { makeStoreCtx, lastProbeMutates } from './store-harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = '/reasoning-level-stats/probe'
const APPLY = '/reasoning-level-stats/probe/apply'
const STATS = '/reasoning-level-stats'
const clone = (v) => JSON.parse(JSON.stringify(v))
const FULL7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

/** llm.stream 桩：每个候选等级都以给定 failure 结束（探测 → blocked 分类）。 */
const blockAll = (code, message) => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

async function mountStore(store, stream) {
  let state
  const made = makeStoreCtx(store, { stream })
  state = made.state
  await mount(made.ctx)
  return state
}

test('(blocked-1) blocked 档位的 code/message/kind 进入 blockedReasons，并随 lastProbe 落盘', async () => {
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: clone(FULL7) }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, blockAll('RATE_LIMITED', '429 too many requests'))
  const r = await callRoute(state, PROBE, { provider: 'gw', model: 'm1' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.blocked.length, 7, '全部档次 blocked 时 7 档都进 blocked')
  assert.equal(Object.keys(r.payload.blockedReasons).length, 7, 'blocked 档位必须逐个带归因')
  assert.deepEqual(r.payload.blockedReasons.max, { code: 'RATE_LIMITED', message: '429 too many requests', kind: 'error' })
  // lastProbe 写入路径保留该字段（/reasoning-level-stats 回显数据源）
  const lp = lastProbeMutates(state)
  assert.ok(lp.length >= 1, '/probe 收口必须写 lastProbe')
  const entry = lp[lp.length - 1].ops[0].value.models['gw/m1']
  assert.deepEqual(entry.blockedReasons.max, { code: 'RATE_LIMITED', message: '429 too many requests', kind: 'error' })
  const stats = await callRoute(state, STATS, {})
  assert.deepEqual(stats.payload.lastProbe.models['gw/m1'].blockedReasons.high.code, 'RATE_LIMITED', 'stats 端点必须带回 blockedReasons')
})

test('(blocked-2) rejected 档位不进入 blockedReasons（能力拒绝语义明确，归因表只服务 blocked）', async () => {
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: clone(FULL7) }] } } },
    deepseek: undefined,
  }
  const stream = async function* (opts) {
    if (opts.reasoningEffort === 'xhigh') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "xhigh" is not supported' } } }
      return
    }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_502', message: 'bad gateway' } } }
  }
  const state = await mountStore(store, stream)
  const r = await callRoute(state, PROBE, { provider: 'gw', model: 'm1' })
  assert.deepEqual(r.payload.rejected, ['xhigh'])
  assert.equal(r.payload.blocked.length, 6)
  assert.equal(r.payload.blockedReasons.xhigh, undefined, 'rejected 档位不得出现在 blockedReasons')
  for (const level of r.payload.blocked) {
    assert.equal(r.payload.blockedReasons[level].code, 'UPSTREAM_502')
  }
})

test('(blocked-3) 官方适配器结局：判据可判定，且 /probe/apply 收口不降级回 not-in-pi-ai-config', async () => {
  // 判据三条同时成立：非 pi-ai 配置 + provider=deepseek-official + llm-deepseek 设置节已注册
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1' }] } } },
    deepseek: { reasoningEffort: 'max' },
  }
  const state = await mountStore(store, async function* () { yield { type: 'finish', reason: { kind: 'stop', failure: null } } })
  const r = await callRoute(state, PROBE, { provider: 'deepseek-official', model: 'v4' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.persisted, 'skipped:official-adapter', '官方适配器管辖 → 独立结局（设计 §10.1）')
  // apply 的 per-model outcome 形状不变（仍是 not-in-pi-ai-config），但 lastProbe 归因不得被降级
  const a = await callRoute(state, APPLY, {
    results: [{ key: 'deepseek-official/v4', provider: 'deepseek-official', model: 'v4', working: r.payload.working, rejected: [], blocked: [] }],
  })
  assert.equal(a.code, 200)
  assert.equal((a.payload.outcomes ?? [])[0].outcome, 'not-in-pi-ai-config')
  // R0-P2-1：汇总计数源必须能区分「官方适配器管理」与「其他适配器提供」——
  // 两者此前共用 reason=not-in-pi-ai-config，导致客户端汇总行把官方模型错算进
  // 「不在 llm-pi-ai 配置」。outcomes 形状保持不变（旧客户端兼容）。
  assert.deepEqual(a.payload.skipped, [{ key: 'deepseek-official/v4', reason: 'official-adapter' }],
    '官方适配器管辖的未写入结局必须带独立 reason（官方 vs 其他适配器）')
  assert.equal(store.nsConfig.lastProbe.models['deepseek-official/v4'].persisted, 'skipped:official-adapter',
    'apply 收口不得把官方适配器归因降级回「不在 llm-pi-ai 配置」（两者是不同结局）')

  // 负相：官方设置节未注册（未安装/未接线）→ 不得凭 provider 名猜测为官方管辖
  const storeWithoutAdapter = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1' }] } } },
    deepseek: undefined,
  }
  const state2 = await mountStore(storeWithoutAdapter, async function* () { yield { type: 'finish', reason: { kind: 'stop', failure: null } } })
  const r2 = await callRoute(state2, PROBE, { provider: 'deepseek-official', model: 'v4' })
  assert.equal(r2.payload.persisted, 'skipped:not-in-pi-ai-config', '官方适配器未接线时不得声称官方管辖（判据必须可判定）')
  const a2 = await callRoute(state2, APPLY, {
    results: [{ key: 'deepseek-official/v4', provider: 'deepseek-official', model: 'v4', working: r2.payload.working, rejected: [], blocked: [] }],
  })
  assert.deepEqual(a2.payload.skipped, [{ key: 'deepseek-official/v4', reason: 'not-in-pi-ai-config' }],
    '官方适配器未接线时 apply 不得给出 official-adapter 归因')
})

// ── ③ 客户端：旧 lastProbe（无 blockedReasons）渲染降级 ────────────────────
// 最小 React 桩（与 client-probe-summary.test.mjs 同构）
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

function collectComponents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.$$ === 'component' && typeof node.tag === 'function' && node.tag.name && !into.some(([n]) => n === node.tag.name)) {
    into.push([node.tag.name, node.tag, node.props])
  }
  for (const child of node.children ?? []) collectComponents(child, into)
  collectComponents(node.props?.children, into)
}
function collectText(node, into) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { into.push(String(node)); return }
  if (typeof node !== 'object') return
  for (const child of node.children ?? []) collectText(child, into)
}

test('(blocked-4) 旧 lastProbe（无 blockedReasons）客户端渲染不崩：未知原因降级 + 官方适配器结论文案', async () => {
  stores.clear()
  // 旧服务端/旧 lastProbe：blocked 非空但没有 blockedReasons；persisted=official 为本次新增枚举
  const STATS_FIXTURE = {
    since: Date.now(),
    totalCalls: 0,
    models: {},
    recent: [],
    blacklist: {},
    lastProbe: {
      t: 1757100000000,
      models: {
        // 旧 lastProbe 形状：blocked 非空但无 blockedReasons 字段
        'demo/m1': { working: [], rejected: [], blocked: ['max', 'xhigh'], persisted: 'skipped:official-adapter' },
        // 新服务端：未知错误原样显示并截断 120 字符（不硬塞进已知分类）
        'demo/m2': {
          working: [], rejected: [], blocked: ['medium'],
          blockedReasons: { medium: { code: 'WEIRD_CODE', message: 'x'.repeat(200) } },
          persisted: 'skipped:no-working',
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
              { ns: 'llm-reasoning', value: { enabled: true, level: 'high', models: {}, purposes: {}, syncDefaultAgent: false, statsPublic: false } },
              { ns: 'llm-pi-ai', value: { providers: {} } },
            ],
          },
        },
      }),
      update: async () => ({ result: { ok: true } }),
      mutate: async () => ({ result: { ok: true } }),
    },
    llm: {
      models: async () => ({ result: { ok: true, value: { groups: [{ id: 'demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }] } }] }] } } }),
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { sandbox.__loaded = def } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => STATS_FIXTURE }),
    AbortController,
  }
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const client = sandbox.__loaded
  assert.ok(client && client.id === 'dsh-reasoning-level', 'client module must load')
  const factoryExports = client.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })
  const registered = []
  factoryExports.apply({
    get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject: (_slot, provider) => provider(),
      register: (meta, render) => { registered.push({ meta, render }); return () => {} },
    },
  })
  assert.equal(registered.length, 1)
  const pageTag = registered[0].render({}).tag
  const pageProps = { api: API }
  resetHooks('ReasoningPage'); pageTag(pageProps); await sleep(10)
  resetHooks('ReasoningPage'); const pageTree = pageTag(pageProps); await sleep(10)

  const components = []
  collectComponents(pageTree, components)
  const statsEntry = components.find(([name]) => name === 'StatsPanel')
  assert.ok(statsEntry, 'StatsPanel must be reachable after load')
  const statsTree = statsEntry[1](statsEntry[2])
  const text = []
  collectText(statsTree, text)
  const all = text.join('|')
  assert.ok(all.includes('demo/m1'), '探测结果表必须回显 lastProbe 模型')
  assert.ok(all.includes('未知原因'), '旧 lastProbe 无 blockedReasons → 该档按「未知原因」降级（不崩、不编造）')
  assert.ok(all.includes('由 DeepSeek 官方适配器管理'), 'skipped:official-adapter 必须渲染新结论文案（PERSISTED_KEYS）')
  // 未知错误：原样显示 code: message，超长截断 120 字符 + 省略号（不硬塞进已知分类）
  assert.ok(all.includes('WEIRD_CODE: '), '未知错误必须原样显示 code/message')
  assert.ok(!all.includes('x'.repeat(130)), '未知错误原文必须截断（120 字符上限）')
  assert.ok(all.includes('…'), '截断必须带省略号')
  // blocked 档位 chips 走 LevelChip 组件（label 在 props 里，不经文本节点）——单独收集
  const chipLabels = []
  ;(function walkChips(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.$$ === 'component' && node.tag?.name === 'LevelChip') chipLabels.push(node.props.label)
    for (const child of node.children ?? []) walkChips(child)
  })(statsTree)
  assert.ok(chipLabels.includes('最大') && chipLabels.includes('极高'), 'blocked 档位 chips 仍按等级名渲染')
})
