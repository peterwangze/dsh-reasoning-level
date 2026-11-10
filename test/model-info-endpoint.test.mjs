/**
 * FEAT-007 模型信息端点判别测试（设计 docs/design/unified-model-workbench-v0.10.md §6）。
 *
 * 判别性（对旧实现全红）：`GET /reasoning-level-models` 不存在（404 / route 缺失）；
 * 即便注册，下列断言锚定新契约——version/routes/models/params/modalities/
 * contractHealth 形状、能力三态（declared/effective/source）、configured 覆盖、
 * listModels/resolveModelInfo 单点失败降级、60s 缓存、并发合并、回环门控。
 *
 * 测试策略：真实 apply() + harness 捕获的真实路由处理器（callRoute 投递模拟
 * req/res），llm.listProviders/listModels/resolveModelInfo 为可计数真实桩——
 * 计数面正是缓存/并发判别的观察点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute } from './harness.mjs'

const MODELS_PATH = '/reasoning-level-models'
const PI_ROUTE = 'zai-coding-cn'
const DS_ROUTE = 'deepseek-official'
const MODEL = 'glm-5.3'
const DS_MODEL = 'deepseek-chat'
const KEY = `${PI_ROUTE}/${MODEL}`

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

const piAiSection = () => ({
  providers: { [PI_ROUTE]: { api: 'openai-completions', models: [{ id: MODEL, name: 'GLM 5.3' }] } },
})
const deepseekSection = () => ({ reasoningEffort: 'high' })

/** 构造带计数面的 llm stub 选项（真实返回形状，非空实现）。 */
function llmStub(overrides = {}) {
  const counters = { listProviders: 0, listModels: 0, resolveModelInfo: 0 }
  const providers = [
    { id: PI_ROUTE, name: 'Z.ai Coding' },
    { id: DS_ROUTE, name: 'DeepSeek' },
  ]
  const catalogs = {
    [PI_ROUTE]: [{ provider: PI_ROUTE, id: MODEL, name: 'GLM 5.3', inputModalities: ['text'] }],
    [DS_ROUTE]: [{ provider: DS_ROUTE, id: DS_MODEL, name: 'DeepSeek Chat', inputModalities: ['text', 'image'] }],
  }
  const infos = {
    [KEY]: {
      provider: PI_ROUTE,
      id: MODEL,
      name: 'GLM 5.3',
      inputModalities: ['text'],
      context: { contextWindow: 200000 },
      defaultMaxTokens: 128000,
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    },
    [`${DS_ROUTE}/${DS_MODEL}`]: {
      provider: DS_ROUTE,
      id: DS_MODEL,
      name: 'DeepSeek Chat',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 128000 },
      defaultMaxTokens: 8192,
    },
  }
  const options = {
    listProviders: () => {
      counters.listProviders += 1
      return overrides.providers !== undefined ? overrides.providers : providers.map((p) => ({ ...p }))
    },
    listModels: async (provider) => {
      counters.listModels += 1
      if (overrides.listModels !== undefined) return overrides.listModels(provider)
      return (catalogs[provider] ?? []).map((entry) => ({ ...entry }))
    },
    resolveModelInfo: async (provider, model) => {
      counters.resolveModelInfo += 1
      if (overrides.resolveModelInfo !== undefined) return overrides.resolveModelInfo(provider, model)
      return infos[provider + '/' + model] === undefined ? undefined : JSON.parse(JSON.stringify(infos[provider + '/' + model]))
    },
  }
  return { options, counters }
}

async function mountEndpoint(llmOverrides = {}, nsExtra = {}) {
  const stub = llmStub(llmOverrides)
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', ...nsExtra },
    piAiSection: piAiSection(),
    deepseekSection: deepseekSection(),
    ...stub.options,
  })
  await mount(ctx)
  await settle()
  // 清零 boot/applyLevel 期间的宿主枚举计数（端点测试只关心端点自身的枚举）
  stub.counters.listProviders = 0
  stub.counters.listModels = 0
  stub.counters.resolveModelInfo = 0
  return { state, counters: stub.counters }
}

// ── A. 响应形状（设计 §6 严格契约）───────────────────────────────────────────
test('(models-1) 路由/模型/注册表投影/契约健康：响应形状完整且只读', async () => {
  const { state } = await mountEndpoint({}, {
    modelInput: { [KEY]: ['image'] },
    modelParams: { [KEY]: { temperature: 0.2 } },
    models: { [KEY]: 'max' },
    defaults: { params: { temperature: 0.7, maxTokens: 8000 } },
  })
  const response = await callRoute(state, MODELS_PATH)
  assert.equal(response.code, 200)
  const payload = response.payload
  assert.equal(payload.version, 1)
  assert.equal(typeof payload.generatedAt, 'number')
  // routes：provider/name/kind（kind 由宿主持有面判定）
  assert.deepEqual(payload.routes, [
    { provider: PI_ROUTE, name: 'Z.ai Coding', kind: 'pi-ai' },
    { provider: DS_ROUTE, name: 'DeepSeek', kind: 'deepseek' },
  ])
  // params/modalities 是 UI 的唯一事实源
  assert.deepEqual(payload.params.map((entry) => entry.id), ['temperature', 'topP', 'topK', 'maxTokens'])
  assert.deepEqual(payload.modalities.map((entry) => entry.id), ['text', 'image'])
  assert.equal(payload.modalities[0].required, true)
  // models：能力三态 + 思考面 + 上下文 + 当前插件覆盖
  assert.equal(payload.models.length, 2)
  const piModel = payload.models.find((entry) => entry.provider === PI_ROUTE && entry.model === MODEL)
  assert.ok(piModel !== undefined, 'pi-ai 模型必须出现在响应中')
  assert.equal(piModel.name, 'GLM 5.3')
  assert.equal(piModel.kind, 'pi-ai')
  assert.deepEqual(piModel.input, { declared: ['text'], effective: ['text', 'image'], source: 'config' })
  assert.deepEqual(piModel.reasoning, { efforts: ['off', 'high'], defaultEffort: 'high' })
  assert.equal(piModel.contextWindow, 200000)
  assert.equal(piModel.maxTokens, 128000)
  assert.deepEqual(piModel.configured, {
    reasoningEffort: 'max',
    input: ['text', 'image'],
    params: { temperature: 0.2, maxTokens: 8000 },
  })
  const dsModel = payload.models.find((entry) => entry.provider === DS_ROUTE && entry.model === DS_MODEL)
  assert.ok(dsModel !== undefined)
  assert.equal(dsModel.kind, 'deepseek')
  assert.deepEqual(dsModel.input, { declared: ['text', 'image'], effective: ['text', 'image'], source: 'catalog' })
  assert.deepEqual(dsModel.reasoning, { efforts: [], defaultEffort: null })
  assert.deepEqual(dsModel.configured, { reasoningEffort: null, input: null, params: { temperature: 0.7, maxTokens: 8000 } })
  assert.deepEqual(payload.contractHealth, { ok: true, missing: [] })
})

test('(models-2) 无任何配置覆盖 → source 取目录值；空输入回退 text', async () => {
  const { state } = await mountEndpoint({}, {})
  const response = await callRoute(state, MODELS_PATH)
  const piModel = response.payload.models.find((entry) => entry.model === MODEL)
  assert.deepEqual(piModel.input, { declared: ['text'], effective: ['text'], source: 'catalog' })
  assert.deepEqual(piModel.configured, { reasoningEffort: null, input: null, params: {} })
})

// ── B. 降级（单点失败不整体 500）─────────────────────────────────────────────
test('(models-3) listModels 失败 → 该路由降级为空，其他路由不受影响，仍 200', async () => {
  const { state } = await mountEndpoint({
    listModels: async (provider) => {
      if (provider === PI_ROUTE) throw new Error('adapter exploded')
      return [{ provider, id: DS_MODEL, name: 'DeepSeek Chat', inputModalities: ['text', 'image'] }]
    },
  })
  const response = await callRoute(state, MODELS_PATH)
  assert.equal(response.code, 200, '单路由 listModels 失败不得整体 500')
  assert.deepEqual(response.payload.routes.map((entry) => entry.provider), [PI_ROUTE, DS_ROUTE])
  assert.deepEqual(response.payload.models.map((entry) => entry.model), [DS_MODEL])
})

test('(models-4) resolveModelInfo 失败 → 模型仍列出，回退目录值（不 over-claim 能力）', async () => {
  const { state } = await mountEndpoint({
    resolveModelInfo: async (provider, model) => {
      if (model === MODEL) throw new Error('resolve exploded')
      return { provider, id: model, name: 'DeepSeek Chat', inputModalities: ['text', 'image'] }
    },
  })
  const response = await callRoute(state, MODELS_PATH)
  assert.equal(response.code, 200)
  const piModel = response.payload.models.find((entry) => entry.model === MODEL)
  assert.ok(piModel !== undefined, '解析失败的模型仍必须可见（目录值降级）')
  assert.equal(piModel.name, 'GLM 5.3', '名称来自 listModels 目录')
  assert.deepEqual(piModel.input, { declared: ['text'], effective: ['text'], source: 'catalog' })
  assert.deepEqual(piModel.reasoning, { efforts: [], defaultEffort: null }, '解析失败不得伪造思考档位')
  assert.equal(piModel.contextWindow, null)
  assert.equal(piModel.maxTokens, null)
})

test('(models-5) listProviders 缺席（旧宿主形态）→ 200 + 空 routes + contractHealth.missing 如实上报', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const response = await callRoute(state, MODELS_PATH)
  assert.equal(response.code, 200, '宿主方法缺席也必须返回可解析 JSON（UI 降级）')
  assert.deepEqual(response.payload.routes, [])
  assert.deepEqual(response.payload.models, [])
  assert.equal(response.payload.contractHealth.ok, false)
  assert.ok(response.payload.contractHealth.missing.includes('llm.listProviders'))
  // params/modalities 仍须下发（客户端 fallback 之外的服务端事实源）
  assert.equal(response.payload.params.length, 4)
  assert.equal(response.payload.modalities.length, 2)
})

// ── C. 缓存与并发 ────────────────────────────────────────────────────────────
test('(models-6) 60s 缓存：重复读取不重复枚举宿主路由/模型', async () => {
  const { state, counters } = await mountEndpoint()
  const first = await callRoute(state, MODELS_PATH)
  const second = await callRoute(state, MODELS_PATH)
  assert.equal(first.code, 200)
  assert.equal(second.code, 200)
  assert.equal(counters.listProviders, 1, 'TTL 窗口内 listProviders 只调用一次')
  assert.equal(counters.listModels, 2, 'TTL 窗口内每路由 listModels 只调用一次')
  assert.equal(counters.resolveModelInfo, 2, 'TTL 窗口内 resolveModelInfo 每模型只调用一次')
  assert.equal(first.payload.generatedAt, second.payload.generatedAt, '缓存命中必须复用同一快照')
})

test('(models-7) 60s 后缓存过期 → 重新枚举', async () => {
  const { state, counters } = await mountEndpoint()
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await callRoute(state, MODELS_PATH)
    assert.equal(counters.listProviders, 1)
    now += 61000
    await callRoute(state, MODELS_PATH)
    assert.equal(counters.listProviders, 2, 'TTL 过期后必须重新枚举')
  } finally {
    Date.now = realNow
  }
})

test('(models-8) 并发请求合并：同一时刻的多个请求共享一次枚举', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let listModelsCalls = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high' },
    piAiSection: piAiSection(),
    listProviders: () => [{ id: PI_ROUTE, name: 'Z.ai Coding' }],
    listModels: async (provider) => {
      listModelsCalls += 1
      await gate
      return [{ provider, id: MODEL, name: 'GLM 5.3', inputModalities: ['text'] }]
    },
    resolveModelInfo: async () => undefined,
  })
  await mount(ctx)
  await settle()
  const first = callRoute(state, MODELS_PATH)
  const second = callRoute(state, MODELS_PATH)
  release()
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.code, 200)
  assert.equal(r2.code, 200)
  assert.equal(listModelsCalls, 1, '并发请求必须合并为一次宿主枚举')
  assert.equal(r1.payload.generatedAt, r2.payload.generatedAt)
})

// ── C2. 缓存失效竞态 ─────────────────────────────────────────────────────────
test('(models-8b) 构建期间设置变更 → 过期快照不得写回缓存（下次读取重建）', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let listModelsCalls = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high' },
    piAiSection: piAiSection(),
    listProviders: () => [{ id: PI_ROUTE, name: 'Z.ai Coding' }],
    listModels: async (provider) => {
      listModelsCalls += 1
      await gate
      return [{ provider, id: MODEL, name: 'GLM 5.3', inputModalities: ['text'] }]
    },
    resolveModelInfo: async () => undefined,
  })
  await mount(ctx)
  await settle()
  const first = callRoute(state, MODELS_PATH)
  // 构建在途时设置变更（真实宿主会 emit settings/document-updated）→ 失效代数递增
  state.handlers.get('settings/document-updated')('llm-reasoning')
  release()
  const firstResponse = await first
  assert.equal(firstResponse.code, 200)
  await callRoute(state, MODELS_PATH)
  assert.equal(listModelsCalls, 2, '失效后下一次读取必须重建，不得命中在途快照写回的旧缓存')
})

// ── D. 回环门控与生命周期 ────────────────────────────────────────────────────
test('(models-9) 回环门控：非回环 Host 默认 403；statsPublic 显式放行', async () => {
  const { state } = await mountEndpoint({}, { statsPublic: false })
  const denied = await callRoute(state, MODELS_PATH, {}, '192.168.1.9')
  assert.equal(denied.code, 403, '默认仅回环可读（与 stats 同口径）')
  const allowed = await callRoute(state, MODELS_PATH, {}, '127.0.0.1')
  assert.equal(allowed.code, 200)
  const publicState = await mountEndpoint({}, { statsPublic: true })
  const lan = await callRoute(publicState.state, MODELS_PATH, {}, '192.168.1.9')
  assert.equal(lan.code, 200, 'statsPublic=true 时放行 LAN（用户显式开启）')
})

test('(models-10) 无 webServer → 不注册端点且其余功能不受影响', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true }, deferWebServer: true })
  await mount(ctx)
  await settle()
  assert.equal(state.routes.has(MODELS_PATH), false, 'webServer 缺席不得注册模型端点')
  assert.equal(state.routeRegistrations.length, 0)
  // 数据面 boot 未被阻断（settings 面仍可读）
  assert.ok(state.describeCalls > 0, '无 webServer 不得影响 boot/设置读取')
})
