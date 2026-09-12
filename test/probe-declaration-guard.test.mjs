/**
 * MAINT-019 回归测试：声明写回判定加固（P2-1 词表形状判定 + P2-3 levelsFilter 缩档）。
 *
 * P2-1（isFullVocabShape 仅按 key 形状判定）：
 *   用户恰好手写 7 键全量 + 自定义 wire（openai 路由 off:'disabled'，本路由标准值为
 *   null）→ 旧判定误分类为「本插件生成」→ 固化/收敛走替换语义，自定义 wire 被标准值
 *   覆盖（DEC-012 红线：用户手写声明 MUST 并入 working 档保 wire）。
 *   修复后：7 键判定叠加 wire 标准性校验（逐键 === buildFullVocabDeclaration(thinkingFormat)）。
 *   (a) 手写 7 键 + 自定义 wire → 并入语义、wire 保留（修复前 RED）
 *   (b) 生成形态 7 键标准 wire → 仍走替换语义（不误伤原行为；修复前后 GREEN）
 *   (f) boot 重算（applyPiAi）不改写手写 7 键 wire（不回归；修复前后 GREEN）
 *
 * P2-3（levelsFilter 缩档陷阱）：
 *   非空 filter 以 filtered working 触发固化收敛 → 声明被替换为筛选子集（缩档）。
 *   修复后：filtered 探测跳过收敛写回（探测照常执行并返回结果），且探测窗口写过的
 *   临时全量声明 MUST 回滚为探测前原声明——不得停留在临时形状。
 *   (c) filter=['low','high'] → 探测正常返回 + 声明未被缩档（修复前 RED）
 *   (d) filter 缺省 / 空数组 → 收敛行为不变（回归；修复前后 GREEN）
 *   (e) filter 非空 + 模型未声明 → 临时声明必须回滚删除（修复前 RED）
 *
 * F-2（MAINT-031 补看护，REVIEW-MAINT-019-R0 §4 F-2）：
 *   filtered 回滚 replace 失败分支（lib/index.js:1324-1331）此前零测试看护——回滚失败时
 *   声明停在探测窗口写入的临时全量形状（用户可见失真），persisted 经 :1182 映射 persist-error。
 *   (g) 注入第 2 次 llm-pi-ai 写（= filtered 回滚）失败 → persist-error + 声明==临时全量形状
 *       （补看护非改行为：不注入失败时同一夹具回 pending-apply，断言非空转）
 *
 * 全程走真实执行路径（apply → 路由处理器 → probeModelLevels/applyProbeResults），
 * 断言对象为 settings.replace 实际写入值与 state.piAiSection 落定值，无桩对桩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, validatingStream, getModelReasoningEfforts, replaceCallsFor } from './harness.mjs'

/** 生成形态的 7 键标准声明（openai-completions 非 zai/deepseek 路由：off=null）。 */
const GENERATED_FULL_VOCAB = {
  off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
}

/** 生成形态的 6 键声明（当前版能力表：无 xhigh）→ 探测前缺 xhigh 触发临时声明写入。 */
const GENERATED_SIX_KEYS = {
  off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max',
}

/** 手写 7 键全量 + 自定义 wire：本路由（openai-completions，非 zai/deepseek）标准 off 为 null。 */
const HANDWRITTEN_FULL_VOCAB = {
  off: 'disabled', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
}

test('(a) MAINT-019 P2-1: 手写 7 键全量 + 自定义 wire → 并入保 wire（DEC-012；修复前 RED）', async () => {
  const piAi = {
    providers: { gateway: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: { ...HANDWRITTEN_FULL_VOCAB } }] } },
  }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)

  // working 含词表外档位 ultra（MAINT-014：非标准档也进固化）→ 迫使走写回分支
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gateway', model: 'm1', working: ['low', 'high', 'ultra'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  const after = getModelReasoningEfforts(state, 'gateway', 'm1')
  // DEC-012 红线：手写 wire 不得被标准值（null）覆盖
  assert.equal(after.off, 'disabled', '手写 off wire 必须保留（自定义 wire 不得被标准值覆盖）')
  // 并入语义：原 7 档全部保留 + 追加实测新档位
  assert.deepEqual(after, { ...HANDWRITTEN_FULL_VOCAB, ultra: 'ultra' })
  assert.equal(r.payload.writes, 1)
  // 手写声明并入 → 非替换：最低限度验证未被缩为 working 子集
  assert.notDeepEqual(after, { low: 'low', high: 'high', ultra: 'ultra' })
})

test('(b) MAINT-019 P2-1 回归: 生成形态 7 键标准 wire → 仍走替换语义（不误伤）', async () => {
  const piAi = {
    providers: { gateway: { api: 'openai-completions', models: [{ id: 'm2', reasoningEfforts: { ...GENERATED_FULL_VOCAB } }] } },
  }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)

  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gateway', model: 'm2', working: ['low', 'high'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  // 生成声明（== buildFullVocabDeclaration）→ 替换为 working 集：既有语义不得被本次加固破坏
  assert.deepEqual(getModelReasoningEfforts(state, 'gateway', 'm2'), { low: 'low', high: 'high' })
})

test('(c) MAINT-019 P2-3: levelsFilter 非空 → 探测正常返回但声明未被缩档（修复前 RED）', async () => {
  const piAi = {
    providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { ...GENERATED_SIX_KEYS } }] } },
  }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    stream: validatingStream(() => state, {}), // 无 behaviors → 全部档位实测可用
  })
  state = _state
  await mount(ctx)

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm', levels: ['low', 'high'] })
  assert.equal(r.code, 200)
  // 探测照常执行：只测筛选子集，结果正常返回
  assert.deepEqual(r.payload.working.sort(), ['high', 'low'])
  assert.deepEqual(Object.keys(r.payload.levels).sort(), ['high', 'low'])
  // 缩档陷阱修复：声明未被 filtered working 替换（既未缩为 2 档，也未停留在临时全量形状）
  assert.deepEqual(getModelReasoningEfforts(state, 'gw', 'm'), GENERATED_SIX_KEYS)
  // 收敛写回被跳过 → 结局为待显式 apply（绝不可上报 persist-error / converged）
  assert.equal(r.payload.persisted, 'pending-apply')
  // 临时声明写入 + 回滚 = 2 次 llm-pi-ai replace，最终形态回到探测前声明
  assert.equal(replaceCallsFor('llm-pi-ai', state).length, 2)
})

test('(d) MAINT-019 P2-3 回归: levelsFilter 缺省 / 空数组 → 收敛行为不变', async () => {
  // 缺省（无 levels 字段）：全量 7 档探测 → 收敛写回不变
  const piAiDefault = {
    providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { ...GENERATED_SIX_KEYS } }] } },
  }
  let stateDefault
  const { ctx: ctxDefault, state: s1 } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAiDefault,
    stream: validatingStream(() => stateDefault, {}),
  })
  stateDefault = s1
  await mount(ctxDefault)
  const rDefault = await callRoute(stateDefault, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(rDefault.code, 200)
  assert.deepEqual(rDefault.payload.working.sort(), ['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'])
  // 收敛照旧：临时全量声明即最终声明（no-change 路径），persisted 保持既有枚举
  assert.deepEqual(getModelReasoningEfforts(stateDefault, 'gw', 'm'), GENERATED_FULL_VOCAB)
  assert.equal(rDefault.payload.persisted, 'no-change-already-correct')

  // 空数组：语义等价于缺省（不得被当成非空 filter 而跳过收敛）
  const piAiEmpty = {
    providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { ...GENERATED_SIX_KEYS } }] } },
  }
  let stateEmpty
  const { ctx: ctxEmpty, state: s2 } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAiEmpty,
    stream: validatingStream(() => stateEmpty, {}),
  })
  stateEmpty = s2
  await mount(ctxEmpty)
  const rEmpty = await callRoute(stateEmpty, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm', levels: [] })
  assert.equal(rEmpty.code, 200)
  assert.deepEqual(rEmpty.payload.working.sort(), ['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'])
  assert.deepEqual(getModelReasoningEfforts(stateEmpty, 'gw', 'm'), GENERATED_FULL_VOCAB)
  assert.equal(rEmpty.payload.persisted, 'no-change-already-correct')
})

test('(e) MAINT-019 P2-3: filter 非空 + 模型未声明 → 临时声明必须回滚删除（修复前 RED）', async () => {
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm' }] } } }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    stream: validatingStream(() => state, {}),
  })
  state = _state
  await mount(ctx)

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm', levels: ['low', 'high'] })
  assert.equal(r.code, 200)
  assert.deepEqual(r.payload.working.sort(), ['high', 'low'])
  // 探测前无声明 → 临时声明被回滚删除：不得因 filtered 探测凭空写出筛选子集声明
  assert.equal(getModelReasoningEfforts(state, 'gw', 'm'), undefined)
  assert.equal(r.payload.persisted, 'pending-apply')
  assert.equal(replaceCallsFor('llm-pi-ai', state).length, 2)
})

test('(g) MAINT-031 F-2 补看护: filtered 回滚 replace 失败 → persist-error 且声明停在临时全量形状', async () => {
  // F-2 看护对象：rollbackProbeDeclaration 的 replace 失败分支（lib/index.js:1324-1331；结局映射 :1182）。
  // filter 非空 + 探测前为 6 键声明 → 1st llm-pi-ai 写 = 临时全量声明（成功），
  // 2nd llm-pi-ai 写 = filtered 回滚（本用例注入失败）→ 回滚未生效。
  const piAi = {
    providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { ...GENERATED_SIX_KEYS } }] } },
  }
  let state
  const writeAttempts = []
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    stream: validatingStream(() => state, {}),
    replaceImpl: (ns, value) => {
      if (ns !== 'llm-pi-ai') return undefined
      writeAttempts.push(value)
      if (writeAttempts.length === 2) throw new Error('injected: filtered rollback replace failed')
      return undefined
    },
  })
  state = _state
  await mount(ctx)

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm', levels: ['low', 'high'] })
  assert.equal(r.code, 200)
  assert.deepEqual(r.payload.working.sort(), ['high', 'low'])
  // 分支锚定：恰 2 次写尝试且第 2 次（回滚）失败——证明断言落在回滚失败分支，而非其他 SKIP 归因
  assert.equal(writeAttempts.length, 2, 'llm-pi-ai 写尝试应为 2 次（临时声明 + filtered 回滚）')
  // 回滚失败经 convergeResult.skipped==='replace-failed' → persist-error（不得谎报 pending-apply）
  assert.equal(r.payload.persisted, 'persist-error', '回滚 replace 失败必须报 persist-error')
  // 回滚未生效 → 声明停在探测临时全量形状（该分支的可见失真面，看护目标即此处）
  assert.deepEqual(getModelReasoningEfforts(state, 'gw', 'm'), GENERATED_FULL_VOCAB)
})

test('(f) MAINT-019 P2-1: boot 重算（applyPiAi）不改写手写 7 键全量 wire（DEC-012；不回归）', async () => {
  // enabled:true → boot 走 applyPiAi（isFullVocabShape 守卫 L547 阻止降级为 6 键生成表）。
  // 本用例钉住该守卫在「7 键判定叠加 wire 校验」后的结局不变：任何一次 llm-pi-ai
  // replace 中手写 wire 都不得被生成表标准值覆盖。
  const piAi = {
    providers: { gateway: { api: 'openai-completions', models: [{ id: 'm3', reasoningEfforts: { ...HANDWRITTEN_FULL_VOCAB } }] } },
  }
  const { ctx, state } = makeCtx({ nsConfig: { enabled: true, level: 'high', statsPublic: true }, piAiSection: piAi })
  await mount(ctx)

  assert.deepEqual(getModelReasoningEfforts(state, 'gateway', 'm3'), HANDWRITTEN_FULL_VOCAB)
  for (const call of replaceCallsFor('llm-pi-ai', state)) {
    const model = call.value.providers.gateway.models.find((m) => m.id === 'm3')
    assert.equal(model.reasoningEfforts.off, 'disabled', 'boot 重算不得把手写 wire 覆盖为生成表标准值')
  }
})
