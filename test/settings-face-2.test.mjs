/**
 * MAINT-035 判别测试：dsh 0.2.0-rc.2 设置系统架构反转（SettingsForms +
 * volatile 自有声明 + describe 读路径 + 事件候选 + 一次性迁移）。
 *
 * 实证基座（宿主活树 0.2.0-rc.2，2026-10-16 复核）：
 *  · dsh-settings 导出面 = {SettingsConflictError, SettingsForms, default,
 *    redactSecrets}——register/get 消失；自有设置 = 插件入口 `export const
 *    Config`（全字段 .volatile()，schemastery 3.18.5 L235），loader 接线
 *    （cordis lib/index.js:1631 Config: plugin.Config），ns = profile entry id。
 *  · describe() 描述符 [{ns, value, base, user, revision, autoGenerate,
 *    applies}]——value = plainConfig 解包 volatile 盒后的有效值投影。
 *  · 事件 settings/updated → settings/document-updated（payload (ns, revision)）。
 *  · 跨 ns 声明形状：pi-ai providers.<route>.models[].reasoningEfforts =
 *    z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]),
 *    z.union(THINKING_LEVELS))])（pi-ai lib :1001/:1008）；llm-deepseek 顶层
 *    reasoningEffort = z.union(["off","low","high","max"]).volatile()；
 *    agent-default-model reasoningEffort = z.string().volatile()。
 *
 * 测试策略（判别原则）：真实 lib/index.js 工件 + 内存版 SettingsForms 桩
 * （harness.mjs / store-harness.mjs）驱动；迁移路径用真实临时 $DSH_HOME +
 * 真实 yaml 包解析（devDep 锁版与宿主平坦树同源）；跨 ns schema 用 devDeps
 * 锁版三包真实工件源判别（pi-ai/llm-deepseek 有未满足的传递 peer 无法整包
 * import——源文本锚判别，host-probes 同款策略）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { makeCtx, mount, loadPlugin, RL_DEFAULTS } from './harness.mjs'
import { makeStoreCtx } from './store-harness.mjs'

const clone = (v) => JSON.parse(JSON.stringify(v))
const settleDeep = () => new Promise((resolve) => setTimeout(resolve, 25))
const FULL7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

/** 临时 DSH_HOME（迁移测试隔离域；restore 恢复原值）。 */
function tempHome() {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-rl-migrate-'))
  process.env.DSH_HOME = home
  return { home, restore: () => { process.env.DSH_HOME = previous; rmSync(home, { recursive: true, force: true }) } }
}

const LEGACY_SECTION = {
  enabled: true,
  level: 'max',
  syncDefaultAgent: true,
  models: { 'glm-local/glm-5.3': 'high' },
  probeEfforts: { 'glm-local/glm-5.3': clone(FULL7) },
  applied: { routes: { 'glm-local': 'max' }, deepseek: {} },
  unknownFutureField: { junk: true },
}

// ── A. 一次性迁移（DEC-019）──────────────────────────────────────────────────
test('(migrate-1) .imported 滞留段 → settings.replace 导入（字段白名单过滤）+ 标记文件落盘', async () => {
  const env = tempHome()
  try {
    writeFileSync(join(env.home, 'settings.yaml.imported'), [
      'llm-deepseek:',
      '  thinking: enabled',
      'llm-reasoning:',
      ...Object.entries(LEGACY_SECTION).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    ].join('\n'), 'utf8')
    const { ctx, state } = makeCtx({ nsConfig: {} })
    await mount(ctx)
    await settleDeep()
    const imports = state.replaceCalls.filter((c) => c.ns === 'llm-reasoning')
    assert.equal(imports.length, 1, '必须恰好一次 replace(NS, 旧段) 导入')
    const value = imports[0].value
    // 白名单：未知字段被过滤，已知字段原样导入
    assert.equal(value.unknownFutureField, undefined, '未知字段不得导入（防意外形状）')
    assert.equal(value.level, 'max')
    assert.equal(value.syncDefaultAgent, true)
    assert.deepEqual(value.models, { 'glm-local/glm-5.3': 'high' })
    assert.deepEqual(value.applied, { routes: { 'glm-local': 'max' }, deepseek: {} })
    // 标记文件：storages/reasoning-level-migrated.json（防重复导入）
    const markerPath = join(env.home, 'storages', 'reasoning-level-migrated.json')
    assert.ok(existsSync(markerPath), '标记文件必须落盘')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    assert.equal(marker.ns, 'llm-reasoning')
    assert.ok(Array.isArray(marker.fields) && marker.fields.includes('level'))
  } finally {
    env.restore()
  }
})

test('(migrate-2) 防重复导入：标记文件在场 → 再次挂载不再导入（用户重置不被 .imported 复活）', async () => {
  const env = tempHome()
  try {
    writeFileSync(join(env.home, 'settings.yaml.imported'), `llm-reasoning:\n  level: max\n`, 'utf8')
    const first = makeCtx({ nsConfig: {} })
    await mount(first.ctx)
    await settleDeep()
    assert.equal(first.state.replaceCalls.filter((c) => c.ns === 'llm-reasoning').length, 1)
    // 第二次挂载（模拟重启）：标记在场 + user 层已被第一次导入填充 → 不再导入
    const second = makeCtx({ nsConfig: { level: 'max' } })
    await mount(second.ctx)
    await settleDeep()
    assert.equal(second.state.replaceCalls.filter((c) => c.ns === 'llm-reasoning').length, 0, '标记在场时不得重复导入')
    // 即便 user 层为空（用户重置）：标记仍然阻断——旧数据不复活
    const third = makeCtx({ nsConfig: {} })
    await mount(third.ctx)
    await settleDeep()
    assert.equal(third.state.replaceCalls.filter((c) => c.ns === 'llm-reasoning').length, 0, '用户重置后标记必须继续阻断 .imported 复活')
  } finally {
    env.restore()
  }
})

test('(migrate-3) user 层非空（新配置已有数据）→ 跳过导入且不写标记', async () => {
  const env = tempHome()
  try {
    writeFileSync(join(env.home, 'settings.yaml.imported'), `llm-reasoning:\n  level: max\n`, 'utf8')
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    await settleDeep()
    assert.equal(state.replaceCalls.filter((c) => c.ns === 'llm-reasoning').length, 0, 'user 层非空不得导入')
    assert.equal(existsSync(join(env.home, 'storages', 'reasoning-level-migrated.json')), false, '未导入不得写标记')
  } finally {
    env.restore()
  }
})

test('(migrate-4) .imported 缺席 → 静默跳过（无导入无标记，boot 照常）', async () => {
  const env = tempHome()
  try {
    const { ctx, state } = makeCtx({ nsConfig: {} })
    await mount(ctx)
    await settleDeep()
    assert.equal(state.replaceCalls.filter((c) => c.ns === 'llm-reasoning').length, 0)
    assert.equal(existsSync(join(env.home, 'storages', 'reasoning-level-migrated.json')), false)
  } finally {
    env.restore()
  }
})

test('(migrate-5) 解析失败（损坏 YAML / yaml 包缺席同类路径）→ 不炸机不写标记，boot-apply 照常执行', async () => {
  const env = tempHome()
  try {
    writeFileSync(join(env.home, 'settings.yaml.imported'), 'llm-reasoning: [broken\n  unclosed', 'utf8')
    const store = { nsConfig: {}, piAi: { providers: { 'glm-local': { api: 'openai-completions', models: [
      { id: 'glm-5.3', reasoningEfforts: clone(FULL7) },
      { id: 'glm-5.3-flash', reasoningEfforts: clone(FULL7) },
    ] } } }, deepseek: undefined }
    const { ctx } = makeStoreCtx(store)
    await mount(ctx)
    await settleDeep()
    assert.equal(existsSync(join(env.home, 'storages', 'reasoning-level-migrated.json')), false, '迁移失败不得写标记（下次 boot 可重试）')
    // boot-apply 未被阻断：enabled 默认 true + level 默认 high → 路由默认已写入
    assert.equal(store.piAi.providers['glm-local'].reasoning, 'high', '迁移失败不得阻断 boot-apply')
  } finally {
    env.restore()
  }
})

// ── B/C. 事件候选注册 + configure 调用 ───────────────────────────────────────
test('(face-1) 事件候选双注册：主名 settings/document-updated + 历史名 settings/updated 都挂 handler 且都驱动 applyLevel', async () => {
  const store = { nsConfig: { enabled: true, level: 'high' }, piAi: { providers: { 'glm-local': { api: 'openai-completions', models: [
    { id: 'glm-5.3', reasoningEfforts: clone(FULL7) },
    { id: 'glm-5.3-flash', reasoningEfforts: clone(FULL7) },
  ] } } }, deepseek: undefined }
  const { ctx, state } = makeStoreCtx(store)
  await mount(ctx)
  await settleDeep()
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'high')
  const primary = state.handlers.get('settings/document-updated')
  const legacy = state.handlers.get('settings/updated')
  assert.ok(typeof primary === 'function', '主名 settings/document-updated handler 必须注册（0.2.0 契约）')
  assert.ok(typeof legacy === 'function', '历史名 settings/updated handler 必须注册（candidates 容错）')
  // 两个名字都驱动 applyLevel：level 变更后经各自 handler 升级 max
  store.nsConfig.level = 'max'
  primary('llm-reasoning')
  await settleDeep()
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'max', '主名 handler 必须驱动 applyLevel')
  store.nsConfig.level = 'high'
  legacy('llm-reasoning')
  await settleDeep()
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'high', '历史名 handler 必须驱动 applyLevel')
  // 无关 ns 不触发
  const before = store.piAi.providers['glm-local'].reasoning
  primary('llm-someone-else')
  await settleDeep()
  assert.equal(store.piAi.providers['glm-local'].reasoning, before, '无关 ns 不得触发 applyLevel')
})

test('(face-2) settings.configure({auto:false}, ctx.fiber) 恰一次（关闭宿主表单自动生成）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  assert.equal(state.configureCalls.length, 1, 'configure 必须恰好调用一次')
  assert.deepEqual(state.configureCalls[0].presentation, { auto: false })
  assert.ok(state.configureCalls[0].owner !== undefined, 'owner 参数（ctx.fiber）必须显式传入')
  assert.deepEqual(state.injectCalls.filter((deps) => deps.includes('settings')), [['settings']], 'settings 运行时可选注入面必须声明')
  assert.deepEqual(state.injectCalls.filter((deps) => deps.includes('webServer')), [['webServer']], 'webServer 必须经 ctx.inject 等待就绪（0.2.x 代序服务晚到，RCA 2026-10-20）')
})

test('(face-3) 读路径统一：describe().value 投影（defaults ∪ user）——自有读取不再依赖 settings.get', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: true, level: 'xhigh', statsPublic: true } })
  await mount(ctx)
  // stats 端点经真实路由读 configOf(NS)（value 投影）：statsPublic 放行 + level 生效链
  const { callRoute } = await import('./harness.mjs')
  const r = await callRoute(state, '/reasoning-level-stats', {}, '10.0.0.5')
  assert.equal(r.code, 200, 'statsPublic=true（user 层）经 value 投影必须放行非回环 Host')
})

// ── D. 自有 Config 声明 + 桩基线 ────────────────────────────────────────────
test('(config-1) Config 全字段 volatile（0.2.0 SettingsForms 只投影 volatile 字段）', async () => {
  const mod = await loadPlugin()
  assert.ok(mod.Config && mod.Config.dict, 'Config schema 必须从插件入口导出（loader 接线面：cordis Config: plugin.Config）')
  const fields = Object.keys(mod.Config.dict)
  assert.ok(fields.length >= 10, `字段面不小于既有 10 字段（实得 ${fields.length}）`)
  for (const field of fields) {
    assert.equal(mod.Config.dict[field].meta?.volatile, true, `字段 ${field} 必须 .volatile()——非 volatile 字段不出现在 0.2.0 设置表单/描述符 value 投影中`)
  }
})

test('(config-2) 桩基线锚定：harness RL_DEFAULTS === Config({}) resolve 的 defaults 投影（不漂移）', async () => {
  const mod = await loadPlugin()
  const resolved = mod.Config({})
  const plain = {}
  for (const [key, value] of Object.entries(resolved)) {
    plain[key] = isVolatile(value) ? value.get() : value
  }
  for (const [key, expected] of Object.entries(RL_DEFAULTS)) {
    assert.deepEqual(plain[key], expected, `harness 桩 defaults 与 Config schema 声明漂移：${key}（桩 ${JSON.stringify(expected)} vs schema ${JSON.stringify(plain[key])}）`)
  }
})

// ── E. 跨 ns 配置 schema 判别（devDeps 锁版三包真实工件）─────────────────────
// pi-ai / llm-deepseek 存在 devDeps 面之外的传递 peer（dsh-launch-environment /
// dsh-attachment），无法整包 import——按 host-probes 判别原则退到源文本锚
//（锁版基线工件，CI fail-closed 同源）。agent-default-model 可整包 import。
test('(cross-ns-1) pi-ai 0.2.0：providers.models[].reasoningEfforts 声明形状幸存（dict(union(string,const(null)), union(LEVELS))，探测固化机制前提）', () => {
  const src = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js', import.meta.url), 'utf8')
  assert.ok(
    src.includes('const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))'),
    'pi-ai reasoningEfforts 值形状锚串缺席——union([z.string(), z.const(null)]) 线值语义漂移将击穿探测固化（写回形状与声明校验）',
  )
  assert.ok(
    src.includes('reasoningEfforts: z.union([z.const(false), reasoningEfforts]'),
    'pi-ai modelFields 的 reasoningEfforts 字段锚串缺席——字段改名 = 探测固化写入被宿主忽略',
  )
})

test('(cross-ns-2) llm-deepseek 0.2.0：顶层 reasoningEffort = union(["off","low","high","max"]).volatile()（applyDeepseek 写入目标面）', () => {
  const src = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js', import.meta.url), 'utf8')
  assert.match(
    src,
    /reasoningEffort:\s*z\.union\(\[\s*"off",\s*"low",\s*"high",\s*"max"\s*\]\)\.volatile\(\)/,
    'llm-deepseek reasoningEffort union 值集/volatile 锚失配——DEEPSEEK_LEVELS 注入目标面漂移',
  )
})

test('(cross-ns-3) agent-default-model 0.2.0：reasoningEffort = z.string().volatile()（applyDefaultAgent 写入目标面，真实 import）', async () => {
  const mod = await import('@deepseek-ai/dsh-agent-default-model')
  // 导出面：{AgentDefaultModelConfig（含静态 Config schema）, default}
  const schema = mod.AgentDefaultModelConfig?.Config ?? mod.Config
  assert.ok(schema && schema.dict, 'agent-default-model Config schema 必须可 import（devDeps 锁版判别工件）')
  const field = schema.dict.reasoningEffort
  assert.ok(field, 'reasoningEffort 字段必须存在（syncDefaultAgent 写入目标面）')
  assert.equal(field.meta?.volatile, true, 'reasoningEffort 必须 volatile（0.2.0 表单面）')
})
