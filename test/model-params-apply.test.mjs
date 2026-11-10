/**
 * FEAT-007 采样参数注入判别测试（设计 docs/design/unified-model-workbench-v0.10.md §4.1/§4.2）。
 *
 * 判别性（对旧实现全红）：旧 lib/index.js 只注入 reasoningEffort，没有任何
 * temperature/maxTokens 通道；本文件锚定：
 *  · agent/request 瀑布返回的 call config 只填 undefined 的 temperature/maxTokens；
 *  · llm/stream 对未冻结 options 同样只填 undefined；probe 请求完全跳过；
 *  · 模型级 modelParams[provider/model] > 全局 defaults.params；
 *  · 调用方显式值优先；topP/topK 只保存、绝不注入（DEC-026 预留语义）；
 *  · 非法配置被 sanitize 丢弃且不导致请求失败。
 *
 * 测试策略：真实 lib/index.js apply() + harness 内存 settings 面，直接驱动
 * state.handlers 上的真实钩子（与生产同一执行路径），不互相印证桩行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { makeCtx, mount, loadPlugin } from './harness.mjs'

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}
const PROVIDER = 'zai-coding-cn'
const MODEL = 'glm-5.3'
const KEY = `${PROVIDER}/${MODEL}`

const piAiSection = () => ({
  providers: {
    [PROVIDER]: {
      api: 'openai-completions',
      models: [{ id: MODEL, name: 'GLM 5.3', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' } }],
      reasoning: 'high',
    },
  },
})

async function agentRequestFor(options, config) {
  const { ctx, state } = makeCtx(options)
  await mount(ctx)
  await settle()
  const handler = state.handlers.get('agent/request')
  assert.ok(typeof handler === 'function', 'agent/request handler must be registered')
  const result = await handler({}, async () => config)
  return { result, state }
}

function streamOptions(extra = {}) {
  return { provider: PROVIDER, model: MODEL, messages: [], ...extra }
}

async function driveStream(options, state) {
  const handler = state.handlers.get('llm/stream')
  assert.ok(typeof handler === 'function', 'llm/stream handler must be registered')
  const wrapped = handler(options, () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop', failure: null } }
  })())
  for await (const _chunk of wrapped) { /* drain */ }
}

// ── A. Config schema（可选字段、旧数据零迁移、全字段 volatile）───────────────
test('(schema-1) 新增字段全部可选且默认 {}：旧 settings 数据零迁移解析', async () => {
  const mod = await loadPlugin()
  const plain = (resolved) => {
    const out = {}
    for (const [key, value] of Object.entries(resolved)) out[key] = isVolatile(value) ? value.get() : value
    return out
  }
  const fresh = plain(mod.Config({}))
  assert.deepEqual(fresh.defaults, { params: {} })
  assert.deepEqual(fresh.modelParams, {})
  assert.deepEqual(fresh.modelInput, {})
  assert.deepEqual(fresh.appliedInputs, {})
  // 旧数据（v0.9.x 形状：只有既有字段）解析不得报错，新字段落默认
  const legacy = plain(mod.Config({ enabled: false, level: 'max', models: { [KEY]: 'high' }, applied: { routes: { [PROVIDER]: 'max' } } }))
  assert.equal(legacy.enabled, false)
  assert.equal(legacy.level, 'max')
  assert.deepEqual(legacy.models, { [KEY]: 'high' })
  assert.deepEqual(legacy.defaults, { params: {} })
  // 新字段可写（preset + params / modelParams / modelInput / appliedInputs）
  const full = plain(mod.Config({
    defaults: { preset: 'precise', params: { temperature: 0.2, topP: 0.9, topK: 20 } },
    modelParams: { [KEY]: { temperature: 0.5, maxTokens: 4096 } },
    modelInput: { [KEY]: ['text', 'image'] },
    appliedInputs: { [KEY]: { written: ['text', 'image'], previous: null } },
  }))
  assert.deepEqual(full.defaults, { preset: 'precise', params: { temperature: 0.2, topP: 0.9, topK: 20 } })
  assert.deepEqual(full.modelParams[KEY], { temperature: 0.5, maxTokens: 4096 })
  assert.deepEqual(full.modelInput[KEY], ['text', 'image'])
  assert.deepEqual(full.appliedInputs[KEY], { written: ['text', 'image'], previous: null })
  // 全字段 volatile（0.2.0 SettingsForms 只投影 volatile 字段）
  for (const field of ['defaults', 'modelParams', 'modelInput', 'appliedInputs']) {
    assert.equal(mod.Config.dict[field].meta?.volatile, true, `${field} 必须 .volatile()`)
  }
})

// ── B. agent/request 注入 ────────────────────────────────────────────────────
test('(agent-1) 只填 undefined：全局 defaults.params 生效，调用方显式值优先', async () => {
  const { result } = await agentRequestFor({
    nsConfig: { enabled: true, level: 'high', defaults: { params: { temperature: 0.2, maxTokens: 2048 } } },
    piAiSection: piAiSection(),
  }, { provider: PROVIDER, model: MODEL })
  assert.equal(result.temperature, 0.2, 'undefined 的 temperature 必须由全局默认填充')
  assert.equal(result.maxTokens, 2048, 'undefined 的 maxTokens 必须由全局默认填充')
  // 调用方显式值不得被覆盖
  const second = await agentRequestFor({
    nsConfig: { enabled: true, level: 'high', defaults: { params: { temperature: 0.2, maxTokens: 2048 } } },
    piAiSection: piAiSection(),
  }, { provider: PROVIDER, model: MODEL, temperature: 1.1, maxTokens: 99 })
  assert.equal(second.result.temperature, 1.1, '调用方显式 temperature 优先')
  assert.equal(second.result.maxTokens, 99, '调用方显式 maxTokens 优先')
})

test('(agent-2) 模型级 modelParams 优先于全局 defaults.params（逐字段）', async () => {
  const { result } = await agentRequestFor({
    nsConfig: {
      enabled: true,
      level: 'high',
      defaults: { params: { temperature: 0.7, maxTokens: 4096 } },
      modelParams: { [KEY]: { temperature: 0.1 } },
    },
    piAiSection: piAiSection(),
  }, { provider: PROVIDER, model: MODEL })
  assert.equal(result.temperature, 0.1, '模型级覆盖优先')
  assert.equal(result.maxTokens, 4096, '未覆盖字段继承全局默认')
})

test('(agent-3) topP/topK 只保存不注入（宿主 0.2.2 GenerateOptions 无字段）', async () => {
  const { result } = await agentRequestFor({
    nsConfig: {
      enabled: true,
      level: 'high',
      defaults: { params: { temperature: 0.3, topP: 0.95, topK: 40 } },
      modelParams: { [KEY]: { topP: 0.5, topK: 10 } },
    },
    piAiSection: piAiSection(),
  }, { provider: PROVIDER, model: MODEL })
  assert.equal(result.temperature, 0.3)
  assert.equal(result.topP, undefined, 'topP 属预留参数，不得进入 call config')
  assert.equal(result.topK, undefined, 'topK 属预留参数，不得进入 call config')
})

test('(agent-4) 插件关闭 / 无配置 → 不注入（返回原对象）', async () => {
  const original = { provider: PROVIDER, model: MODEL }
  const disabled = await agentRequestFor({
    nsConfig: { enabled: false, defaults: { params: { temperature: 0.2 } } },
    piAiSection: piAiSection(),
  }, original)
  assert.equal(disabled.result.temperature, undefined, '关闭插件时不得注入参数')
  const empty = await agentRequestFor({ nsConfig: { enabled: true, level: 'high' }, piAiSection: piAiSection() }, original)
  assert.equal(empty.result.temperature, undefined, '未配置参数时不得注入')
})

test('(agent-5) 非法参数被 sanitize 丢弃且请求不失败（temperature 越界 / topK 非整数脏值）', async () => {
  const { result } = await agentRequestFor({
    nsConfig: {
      enabled: true,
      level: 'high',
      defaults: { params: { temperature: 9, maxTokens: 0 } },
      modelParams: { [KEY]: { topK: 3.7 } },
    },
    piAiSection: piAiSection(),
  }, { provider: PROVIDER, model: MODEL })
  assert.equal(result.temperature, undefined, '越界 temperature 必须被丢弃，而不是写入请求')
  assert.equal(result.maxTokens, undefined, '越界 maxTokens 必须被丢弃')
  assert.equal(result.topK, undefined)
  assert.equal(result.provider, PROVIDER, '请求配置其余字段不变')
})

test('(agent-6) 与既有 reasoning 注入共存：参数注入不改变模型级思考等级语义', async () => {
  const { result } = await agentRequestFor({
    nsConfig: {
      enabled: true,
      level: 'high',
      models: { [KEY]: 'max' },
      defaults: { params: { temperature: 0.2 } },
    },
    piAiSection: piAiSection(),
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }),
  }, { provider: PROVIDER, model: MODEL })
  assert.equal(result.reasoningEffort, 'max', '既有模型级思考等级注入必须保持')
  assert.equal(result.temperature, 0.2, '参数注入与 reasoning 注入共存')
})

// ── C. llm/stream 注入 ───────────────────────────────────────────────────────
test('(stream-1) 未冻结 options 只填 undefined 的 temperature/maxTokens', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', defaults: { params: { temperature: 0.2, maxTokens: 2048 } } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const options = streamOptions()
  await driveStream(options, state)
  assert.equal(options.temperature, 0.2)
  assert.equal(options.maxTokens, 2048)
  // 显式值优先
  const explicit = streamOptions({ temperature: 1.1, maxTokens: 77 })
  await driveStream(explicit, state)
  assert.equal(explicit.temperature, 1.1)
  assert.equal(explicit.maxTokens, 77)
  // 冻结 options 完全跳过
  const frozen = Object.freeze(streamOptions())
  await driveStream(frozen, state)
  assert.equal(frozen.temperature, undefined, '冻结 options 不得原地写入')
  assert.equal(frozen.maxTokens, undefined)
  // 预留参数不出现
  assert.equal(options.topP, undefined)
  assert.equal(options.topK, undefined)
})

test('(stream-2) 模型级参数在 llm/stream 同样优先', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: {
      enabled: true,
      level: 'high',
      defaults: { params: { temperature: 0.7, maxTokens: 4096 } },
      modelParams: { [KEY]: { maxTokens: 1024 } },
    },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const options = streamOptions()
  await driveStream(options, state)
  assert.equal(options.temperature, 0.7)
  assert.equal(options.maxTokens, 1024, '模型级 maxTokens 优先')
})

test('(stream-3) probe 请求完全跳过（不注入、不改动 options）', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', defaults: { params: { temperature: 0.2, maxTokens: 2048 } } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const options = streamOptions({ probe: true })
  await driveStream(options, state)
  assert.equal(options.temperature, undefined, 'probe 请求不得注入 temperature')
  assert.equal(options.maxTokens, undefined, 'probe 请求不得注入 maxTokens')
})

test('(stream-4) 插件关闭 → 不注入', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, defaults: { params: { temperature: 0.2, maxTokens: 2048 } } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const options = streamOptions()
  await driveStream(options, state)
  assert.equal(options.temperature, undefined)
  assert.equal(options.maxTokens, undefined)
})
