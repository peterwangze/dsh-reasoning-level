/**
 * FEAT-007 多模态能力写回判别测试（设计 docs/design/unified-model-workbench-v0.10.md §4.3）。
 *
 * 判别性（对旧实现全红）：`lib/model-capabilities.js` 不存在；即便存在，下列断言
 * 锚定的是新语义——三种写点（pi-ai models / pi-ai modelOverrides / deepseek
 * models）、写前 previous 台账、撤销仅当 current deepEqual written、用户手改不
 * 覆盖、缺目录跳过。旧实现没有任何多模态写回行为。
 *
 * 测试策略：纯函数用真实宿主 section 形状夹具（pi-ai providers.*.models 与
 * modelOverrides、llm-deepseek models.inputModalities）；端到端用例用 harness
 * 真实驱动 apply()/applyLevel（settings.replace 落到内存节），不用互证桩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount } from './harness.mjs'
import {
  MODALITIES,
  normalizeInput,
  parseModelKey,
  planInputWrite,
  planInputRevert,
} from '../lib/model-capabilities.js'

const clone = (v) => JSON.parse(JSON.stringify(v))
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

const ROUTE = 'zai-coding-cn'
const MODEL = 'glm-5.3'

/** 真实 pi-ai section 形状：models 数组条目带目录字段（写回必须保留其余字段）。 */
function piAiSection() {
  return {
    providers: {
      [ROUTE]: {
        api: 'openai-completions',
        models: [
          {
            id: MODEL,
            name: 'GLM 5.3',
            contextWindow: 200000,
            maxTokens: 128000,
            reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
          },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 128000, maxTokens: 8192 },
        ],
        reasoning: 'high',
      },
    },
  }
}

/** 真实 llm-deepseek section 形状（models[].inputModalities）。 */
function deepseekSection() {
  return {
    reasoningEffort: 'high',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text'] },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 64000, maxTokens: 8192, inputModalities: ['text'] },
    ],
  }
}

// ── A. 模态注册表 ────────────────────────────────────────────────────────────
test('(modalities-1) MODALITIES：text 必选、image 可选，标签 zh/en 成对', () => {
  assert.deepEqual(MODALITIES.map((entry) => entry.id), ['text', 'image'])
  assert.equal(MODALITIES[0].required, true, 'text 必须是必选模态')
  assert.equal(MODALITIES[1].required, false, 'image 必须是可选模态')
  for (const entry of MODALITIES) {
    assert.ok(typeof entry.label?.zh === 'string' && entry.label.zh.length > 0)
    assert.ok(typeof entry.label?.en === 'string' && entry.label.en.length > 0)
  }
  assert.ok(Object.isFrozen(MODALITIES), 'MODALITIES 必须冻结')
})

test('(modalities-2) normalizeInput：去重 + 强制 text + 仅注册模态 + 空回退', () => {
  assert.deepEqual(normalizeInput(['text']), ['text'])
  assert.deepEqual(normalizeInput(['image']), ['text', 'image'], 'text 恒在（顺序规范化）')
  assert.deepEqual(normalizeInput(['image', 'text']), ['text', 'image'])
  assert.deepEqual(normalizeInput(['text', 'image', 'image']), ['text', 'image'], '去重')
  assert.deepEqual(normalizeInput(['audio', 'video']), ['text'], '未注册模态丢弃')
  assert.deepEqual(normalizeInput(['text', 'audio']), ['text'])
  assert.deepEqual(normalizeInput([]), ['text'])
  assert.deepEqual(normalizeInput(undefined), ['text'])
  assert.deepEqual(normalizeInput('image'), ['text'], '非数组输入回退 text')
})

test('(key-1) parseModelKey：按首个 / 切分 provider/model；非法键返回 undefined', () => {
  assert.deepEqual(parseModelKey('zai-coding-cn/glm-5.3'), { provider: 'zai-coding-cn', model: 'glm-5.3' })
  assert.deepEqual(parseModelKey('openrouter/vendor/model'), { provider: 'openrouter', model: 'vendor/model' })
  assert.equal(parseModelKey('zai-coding-cn'), undefined)
  assert.equal(parseModelKey('/glm-5.3'), undefined)
  assert.equal(parseModelKey('zai-coding-cn/'), undefined)
  assert.equal(parseModelKey(undefined), undefined)
})

// ── B. 三种写点 ──────────────────────────────────────────────────────────────
test('(write-1) pi-ai models 数组：写 input 且保留其余字段；previous 记录写入前值', () => {
  const section = piAiSection()
  const before = clone(section)
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['image'] })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.written, ['text', 'image'])
  assert.equal(plan.previous, null, '原本缺省 input → previous = null')
  const entry = plan.section.providers[ROUTE].models.find((item) => item.id === MODEL)
  assert.deepEqual(entry.input, ['text', 'image'])
  assert.equal(entry.name, 'GLM 5.3', '其余字段必须保留')
  assert.equal(entry.contextWindow, 200000)
  assert.deepEqual(entry.reasoningEfforts, before.providers[ROUTE].models[0].reasoningEfforts)
  // 不得原地修改输入
  assert.deepEqual(section, before, 'planInputWrite 不得原地修改输入 section')
})

test('(write-2) pi-ai models 数组：已有 input 时记录 previous 为写入前数组', () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text']
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['text', 'image'] })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.previous, ['text'])
})

test('(write-3) 值未变化 → changed=false（调用方据此跳过 replace）', () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text', 'image']
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['image', 'text'] })
  assert.equal(plan.changed, false, '规范化后与当前值相同不得重写')
  assert.deepEqual(plan.previous, ['text', 'image'])
})

test('(write-4) pi-ai models 缺省/空 → 写 modelOverrides（保留既有覆盖项其他字段）', () => {
  const section = { providers: { [ROUTE]: { api: 'openai-completions', modelOverrides: { 'glm-5.3': { compat: { thinkingFormat: 'zai' } } } } } }
  const before = clone(section)
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['text', 'image'] })
  assert.equal(plan.changed, true)
  assert.equal(plan.previous, null)
  assert.deepEqual(plan.section.providers[ROUTE].modelOverrides[MODEL], {
    compat: { thinkingFormat: 'zai' },
    input: ['text', 'image'],
  })
  assert.deepEqual(section, before, '不得原地修改输入 section')
  // 空 models 数组同样走 modelOverrides（宿主：beside a models list → invalid）
  const emptyModels = { providers: { [ROUTE]: { api: 'openai-completions', models: [] } } }
  const plan2 = planInputWrite({ section: emptyModels, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['text'] })
  assert.equal(plan2.changed, true)
  assert.deepEqual(plan2.section.providers[ROUTE].modelOverrides[MODEL], { input: ['text'] })
})

test('(write-5) pi-ai models 数组非空但模型不在列表 → 跳过（不得改写成 modelOverrides，宿主会拒）', () => {
  const section = piAiSection()
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: ROUTE, model: 'ghost', input: ['image'] })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'model-not-declared')
  assert.deepEqual(plan.section, section)
})

test('(write-6) pi-ai 路由缺席 → 跳过', () => {
  const section = piAiSection()
  const plan = planInputWrite({ section, kind: 'pi-ai', provider: 'ghost-route', model: MODEL, input: ['image'] })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'route-missing')
  assert.deepEqual(plan.section, section)
})

test('(write-7) deepseek models 数组：写 inputModalities 且保留其余字段', () => {
  const section = deepseekSection()
  const before = clone(section)
  const plan = planInputWrite({ section, kind: 'deepseek', provider: 'deepseek-official', model: 'deepseek-chat', input: ['text', 'image'] })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.previous, ['text'])
  const entry = plan.section.models.find((item) => item.id === 'deepseek-chat')
  assert.deepEqual(entry.inputModalities, ['text', 'image'])
  assert.equal(entry.name, 'DeepSeek Chat')
  assert.equal(entry.contextWindow, 128000)
  assert.deepEqual(plan.section.models.find((item) => item.id === 'deepseek-reasoner').inputModalities, ['text'], '其他模型不受影响')
  assert.deepEqual(section, before, '不得原地修改输入 section')
})

test('(write-8) deepseek raw models 缺省（内置目录未物化）→ 跳过，绝不凭空创建 models', () => {
  const section = { reasoningEffort: 'high' }
  const plan = planInputWrite({ section, kind: 'deepseek', provider: 'deepseek-official', model: 'deepseek-chat', input: ['image'] })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'no-catalog-models')
  assert.deepEqual(plan.section, section)
})

test('(write-9) deepseek raw models 存在但模型不在目录 → 跳过', () => {
  const section = deepseekSection()
  const plan = planInputWrite({ section, kind: 'deepseek', provider: 'deepseek-official', model: 'ghost', input: ['image'] })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'model-not-in-catalog')
  assert.deepEqual(plan.section, section)
})

test('(write-10) 未知 kind → 跳过且不抛错', () => {
  const plan = planInputWrite({ section: {}, kind: 'other', provider: 'x', model: 'y', input: ['image'] })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'unknown-kind')
})

// ── C. 撤销规划 ──────────────────────────────────────────────────────────────
test('(revert-1) pi-ai models：current == written 且 previous 为 null → 删除 input 属性', () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text', 'image']
  const plan = planInputRevert({
    section,
    kind: 'pi-ai',
    provider: ROUTE,
    model: MODEL,
    written: ['text', 'image'],
    previous: null,
  })
  assert.equal(plan.changed, true)
  assert.equal(plan.restored, null)
  const entry = plan.section.providers[ROUTE].models[0]
  assert.equal('input' in entry, false, 'previous=null 必须删除字段而不是写空数组')
  assert.equal(entry.name, 'GLM 5.3', '其余字段保留')
  assert.deepEqual(section.providers[ROUTE].models[0].input, ['text', 'image'], '不得原地修改输入')
})

test('(revert-2) pi-ai models：previous 为数组 → 恢复写入前值', () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text', 'image']
  const plan = planInputRevert({
    section,
    kind: 'pi-ai',
    provider: ROUTE,
    model: MODEL,
    written: ['text', 'image'],
    previous: ['image'],
  })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.restored, ['image'])
  assert.deepEqual(plan.section.providers[ROUTE].models[0].input, ['image'])
})

test('(revert-3) modelOverrides：previous=null → 删除 input 与空覆盖项（含空 modelOverrides）', () => {
  const section = { providers: { [ROUTE]: { api: 'openai-completions', modelOverrides: { [MODEL]: { input: ['text', 'image'] } } } } }
  const plan = planInputRevert({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, written: ['text', 'image'], previous: null })
  assert.equal(plan.changed, true)
  assert.equal(plan.section.providers[ROUTE].modelOverrides, undefined, '只含本插件写入的空覆盖项必须整键删除')
})

test('(revert-4) modelOverrides：覆盖项还有其他字段 → 只删 input，保留条目', () => {
  const section = { providers: { [ROUTE]: { modelOverrides: { [MODEL]: { compat: { thinkingFormat: 'zai' }, input: ['text', 'image'] } } } } }
  const plan = planInputRevert({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, written: ['text', 'image'], previous: null })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.section.providers[ROUTE].modelOverrides[MODEL], { compat: { thinkingFormat: 'zai' } })
})

test('(revert-5) deepseek：previous=null → 删除 inputModalities；previous 数组 → 恢复', () => {
  const section = deepseekSection()
  section.models[0].inputModalities = ['text', 'image']
  const plan = planInputRevert({ section, kind: 'deepseek', provider: 'deepseek-official', model: 'deepseek-chat', written: ['text', 'image'], previous: null })
  assert.equal(plan.changed, true)
  assert.equal('inputModalities' in plan.section.models[0], false)
  const plan2 = planInputRevert({ section, kind: 'deepseek', provider: 'deepseek-official', model: 'deepseek-chat', written: ['text', 'image'], previous: ['text'] })
  assert.deepEqual(plan2.section.models[0].inputModalities, ['text'])
})

test('(revert-6) 用户手改（current != written）→ 不动当前值，标记 user-modified', () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text']
  const plan = planInputRevert({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, written: ['text', 'image'], previous: null })
  assert.equal(plan.changed, false)
  assert.equal(plan.skipped, 'user-modified')
  assert.deepEqual(plan.section.providers[ROUTE].models[0].input, ['text'], '用户手改的值不得被覆盖')
})

test('(revert-7) 结构已不存在 → changed=false（幂等：重复撤销不抛错）', () => {
  // 路由从宿主配置中被移除（适配器卸载/用户删路由）：无可撤销结构
  const section = { providers: {} }
  const first = planInputRevert({ section, kind: 'pi-ai', provider: ROUTE, model: MODEL, written: ['text', 'image'], previous: null })
  assert.equal(first.changed, false)
  assert.equal(first.skipped, 'not-applicable')
  const deepseekAbsent = planInputRevert({ section: { reasoningEffort: 'high' }, kind: 'deepseek', provider: 'deepseek-official', model: 'deepseek-chat', written: ['text', 'image'], previous: null })
  assert.equal(deepseekAbsent.changed, false)
  assert.equal(deepseekAbsent.skipped, 'not-applicable')
})

test('(cycle-1) 写 → 撤销 → 再写：幂等且结果与首次写一致', () => {
  const original = piAiSection()
  const write1 = planInputWrite({ section: original, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['text', 'image'] })
  const revert = planInputRevert({
    section: write1.section,
    kind: 'pi-ai',
    provider: ROUTE,
    model: MODEL,
    written: write1.written,
    previous: write1.previous,
  })
  assert.equal(revert.changed, true)
  const write2 = planInputWrite({ section: revert.section, kind: 'pi-ai', provider: ROUTE, model: MODEL, input: ['text', 'image'] })
  assert.equal(write2.changed, true)
  assert.deepEqual(write2.section, write1.section, '写-撤-写必须回到同一宿主截面')
  assert.deepEqual(write2.previous, write1.previous)
})

// ── D. 端到端（真实 apply()/applyLevel + 内存 settings 面）─────────────────────
test('(e2e-1) 启用：modelInput 写入 pi-ai 宿主节 + appliedInputs 台账落盘', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['image'] } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  const entry = state.piAiSection.providers[ROUTE].models.find((item) => item.id === MODEL)
  assert.deepEqual(entry.input, ['text', 'image'], '宿主 llm-pi-ai 对应模型条目必须写入 input')
  assert.equal(entry.name, 'GLM 5.3', '写回不得丢失条目其余字段')
  assert.deepEqual(state.nsConfig.appliedInputs, {
    [`${ROUTE}/${MODEL}`]: { written: ['text', 'image'], previous: null },
  }, '写入成功后必须登记 appliedInputs（written/previous）')
})

test('(e2e-2) 关闭插件：撤销回写入前状态并清空台账', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text', 'image'])
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.equal('input' in state.piAiSection.providers[ROUTE].models[0], false, '关闭后 input 必须恢复为原本缺省')
  assert.deepEqual(state.nsConfig.appliedInputs, {}, '撤销后台账必须清空')
})

test('(e2e-3) 用户手改后关闭：不得覆盖用户值，但台账条目清除', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  // 用户在宿主设置里手改（llm-pi-ai 原始节）
  state.piAiSection.providers[ROUTE].models[0].input = ['text']
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text'], '用户手改值必须保留（所有权门控）')
  assert.deepEqual(state.nsConfig.appliedInputs, {}, '即使不还原也必须清除台账（尊重用户手改）')
})

test('(e2e-4) 重启后（台账来自持久面）关闭仍可还原写入前值', async () => {
  const first = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: piAiSection(),
  })
  await mount(first.ctx)
  await settle()
  const persisted = JSON.parse(JSON.stringify(first.state.nsConfig))
  assert.ok(persisted.appliedInputs !== undefined, '台账必须落在持久面上')
  // 模拟重启：新 ctx（内存台账清空）+ 同一持久面 + 已关闭
  const second = makeCtx({
    nsConfig: { ...persisted, enabled: false },
    piAiSection: JSON.parse(JSON.stringify(first.state.piAiSection)),
  })
  await mount(second.ctx)
  await settle()
  assert.equal('input' in second.state.piAiSection.providers[ROUTE].models[0], false, '重启后凭 appliedInputs 台账必须可还原')
  assert.deepEqual(second.state.nsConfig.appliedInputs, {})
})

test('(e2e-5) pi-ai models 缺省 → modelOverrides 写点（端到端）', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: { providers: { [ROUTE]: { api: 'openai-completions' } } },
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].modelOverrides[MODEL].input, ['text', 'image'])
})

test('(e2e-6) deepseek models 写点（端到端）+ 关闭还原', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { 'deepseek-official/deepseek-chat': ['text', 'image'] } },
    deepseekSection: deepseekSection(),
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.deepseekSection.models[0].inputModalities, ['text', 'image'])
  assert.equal(state.deepseekSection.models[0].contextWindow, 128000, '其余字段保留')
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.deepseekSection.models[0].inputModalities, ['text'], '关闭后恢复写入前值')
})

test('(e2e-7) deepseek raw models 缺省 → 跳过（不凭空物化内置目录）', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { 'deepseek-official/deepseek-chat': ['text', 'image'] } },
    deepseekSection: { reasoningEffort: 'high' },
  })
  await mount(ctx)
  await settle()
  assert.equal(state.replaceCalls.filter((call) => call.ns === 'llm-deepseek').length, 0, '不得写 llm-deepseek 整节')
  assert.equal(state.deepseekSection.models, undefined, '不得凭空创建 models 数组')
})

test('(e2e-9) 二次修改我方写入值（pi-ai）：撤销恢复宿主原始值，不得恢复成上一次我方值', async () => {
  const section = piAiSection()
  section.providers[ROUTE].models[0].input = ['text'] // 宿主原始声明
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: section,
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text', 'image'])
  assert.deepEqual(state.nsConfig.appliedInputs[`${ROUTE}/${MODEL}`], { written: ['text', 'image'], previous: ['text'] })
  // 用户关闭图像：modelInput 改为 ['text']（我方第二次写入）
  state.nsConfig.modelInput = { [`${ROUTE}/${MODEL}`]: ['text'] }
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text'])
  assert.deepEqual(
    state.nsConfig.appliedInputs[`${ROUTE}/${MODEL}`],
    { written: ['text'], previous: ['text'] },
    '原始 previous 必须保留（不得被上一次我方写入值 text+image 覆盖）',
  )
  // 关闭插件/删除覆盖 → 撤销必须恢复宿主原始 text（而不是重新打开图像）
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text'], '撤销不得把图像错误重新打开')
  assert.deepEqual(state.nsConfig.appliedInputs, {})
})

test('(e2e-10) 二次修改我方写入值（deepseek）：撤销恢复宿主原始 inputModalities', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { 'deepseek-official/deepseek-chat': ['text', 'image'] } },
    deepseekSection: deepseekSection(),
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.deepseekSection.models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(state.nsConfig.appliedInputs['deepseek-official/deepseek-chat'], { written: ['text', 'image'], previous: ['text'] })
  state.nsConfig.modelInput = { 'deepseek-official/deepseek-chat': ['text'] }
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.deepseekSection.models[0].inputModalities, ['text'])
  assert.deepEqual(
    state.nsConfig.appliedInputs['deepseek-official/deepseek-chat'],
    { written: ['text'], previous: ['text'] },
    'deepseek 写入同样必须保留原始 previous',
  )
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.deepseekSection.models[0].inputModalities, ['text'], '撤销恢复宿主原始值')
})

test('(e2e-11) 用户手改后再由我方写入：新基线取用户手改值（撤销不得回到更早基线）', async () => {
  const section = piAiSection() // 宿主原始 input 缺省（previous = null）
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { [`${ROUTE}/${MODEL}`]: ['text', 'image'] } },
    piAiSection: section,
  })
  await mount(ctx)
  await settle()
  assert.deepEqual(state.nsConfig.appliedInputs[`${ROUTE}/${MODEL}`], { written: ['text', 'image'], previous: null })
  // 用户手改宿主值为 ['text']（不是我方写入值）
  state.piAiSection.providers[ROUTE].models[0].input = ['text']
  // 用户再次声明图像（我方在用户手改值之上写入）→ 新基线 = 用户值
  state.nsConfig.modelInput = { [`${ROUTE}/${MODEL}`]: ['text', 'image'] }
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text', 'image'])
  assert.deepEqual(
    state.nsConfig.appliedInputs[`${ROUTE}/${MODEL}`],
    { written: ['text', 'image'], previous: ['text'] },
    '用户手改后的值必须成为新基线（不是最初的 null）',
  )
  state.nsConfig.enabled = false
  state.handlers.get('settings/document-updated')('llm-reasoning')
  await settle()
  assert.deepEqual(state.piAiSection.providers[ROUTE].models[0].input, ['text'], '撤销恢复用户手改基线')
})

test('(e2e-8) modelInput 指向不存在的 pi-ai 路由 → 跳过且不落台账', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', modelInput: { 'ghostRoute/ghost-model': ['text', 'image'] } },
    piAiSection: piAiSection(),
  })
  await mount(ctx)
  await settle()
  // applyPiAi 可能因能力声明升级而写 llm-pi-ai；但多模态写回自身必须完全不写：
  // 无 modelOverrides 条目、任何模型条目都没有 input 字段、台账不登记。
  for (const call of state.replaceCalls.filter((entry) => entry.ns === 'llm-pi-ai')) {
    const providers = call.value.providers ?? {}
    for (const profile of Object.values(providers)) {
      assert.equal(profile.modelOverrides, undefined, '路由以外的 modelInput 键不得产生 modelOverrides')
      for (const model of Array.isArray(profile.models) ? profile.models : []) {
        assert.equal('input' in model, false, '缺目录不得写 input')
      }
    }
  }
  assert.equal(state.nsConfig.appliedInputs, undefined, '未写入不得登记台账')
})

