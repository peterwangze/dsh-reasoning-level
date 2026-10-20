/**
 * HTTP 端点「webServer 晚到」判别测试（RCA 2026-10-20，0.2.x 代序服务时序号）。
 *
 * 真实事故：用户运行实例（dsh 0.2.1-rc.2，profile=web）四个端点全部 404，
 * 同宿主兄弟插件（dsh-agent-router，static inject 含 webServer）路由 200。
 * 根因：lib/index.js 在 apply() 期一次性 ctx.get('webServer')；cordis 4 的
 * ctx.get(name, strict=true) 在提供方 fiber 未 ACTIVE 时返回 undefined
 * （ReflectService.get/_getImpl：strict && impl.fiber.state !== 2 → return），
 * 而 DSH 0.2.x 代序中 webServer 常在 profile 行插件 apply 之后才挂载
 * （兄弟项目 writing-workflow lib/host-boundary.js L155-165 契约化先例）——
 * 整块路由注册被静默跳过，无任何日志。
 *
 * 本文件是该缺陷的回归防护网（判别性质：旧实现 apply 期无 webServer 时，
 * 即使服务随后到货也永不挂载 → late-2/late-3/late-5 红）。用例覆盖：
 *  ① apply 期无 webServer → 四端点均未注册且不抛错（静默降级不炸机）；
 *  ② provideWebServer() 迟到挂载 → 四端点全部注册，stats 200 + 合法 JSON；
 *  ③ 重复 provide / 同实例二次注入 → register 次数稳定（无双注册）；
 *  ④ 宿主无 ctx.inject 表面 → 回退一次性 ctx.get（既有行为保持）；
 *  ⑤ 服务重启（新实例）→ 旧路由随 scope effect 销毁、新实例重挂。
 *
 * 夹具：test/harness.mjs 的 ctx.inject 按依赖名分派（['settings']/['webServer']），
 * deferWebServer=true 模拟 apply 期服务不可见。RED 证据（本文件对旧实现
 * 「apply 期一次性 ctx.get」运行）：late-2 / late-3 / late-5 因路由数恒 0 失败
 * （旧实现无注入监听，服务迟到到货后永不补挂）；late-4 另因旧实现无条件调用
 * ctx.inject(settings) 抛 TypeError（本次一并补了无注入表面的降级守卫）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute } from './harness.mjs'

const STATS = '/reasoning-level-stats'
/** 统计/测试/探测/固化四个端点（顺序 = 注册顺序）。 */
const ENDPOINTS = [STATS, STATS + '/test', STATS + '/probe', STATS + '/probe/apply']

/** 等待挂载链落定（provideWebServer 当前为同步投递，保留异步窗口与 mount 一致）。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('(late-1) apply 期无 webServer → 四个端点均未注册且不抛错（静默降级不炸机）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true }, deferWebServer: true })
  await mount(ctx) // 不抛错即通过：插件行加载绝不能依赖 webServer 就绪
  for (const path of ENDPOINTS) {
    assert.equal(state.routes.has(path), false, `apply 期 webServer 未挂载时不得注册 ${path}`)
  }
  assert.equal(state.routeRegistrations.length, 0, 'apply 期不得发生任何 register 调用')
  // 未注册 ≠ 失败：提供方到货后仍须可挂载（late-2 正面证明）
})

test('(late-2) provideWebServer() 迟到挂载 → 四端点全部注册且 stats 返回 200 + 合法 JSON', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: true, level: 'high', statsPublic: true }, deferWebServer: true })
  await mount(ctx)
  state.provideWebServer()
  await settle()
  for (const path of ENDPOINTS) {
    assert.ok(state.routes.has(path), `webServer 迟到到货后必须挂载 ${path}（0.2.x 代序静默失效回归）`)
  }
  assert.equal(state.routeRegistrations.length, ENDPOINTS.length, '四条路由各注册一次（无重复）')
  const r = await callRoute(state, STATS)
  assert.equal(r.code, 200, 'stats 端点必须可读')
  assert.equal(typeof r.payload.since, 'number', 'stats JSON 必含 since')
  assert.equal(typeof r.payload.totalCalls, 'number', 'stats JSON 必含 totalCalls')
  assert.equal(typeof r.payload.models, 'object', 'stats JSON 必含 models')
  assert.ok(Array.isArray(r.payload.recent), 'stats JSON 必含 recent 数组')
  assert.equal(typeof r.payload.blacklist, 'object', 'stats JSON 必含 blacklist')
  // 契约自检不得因迟到挂载路径而静默失效（register 可见且为函数 → ok）
  assert.equal(r.payload.contractHealth.ok, true, 'webServer 正常时 contractHealth.ok 必须为 true')
  assert.deepEqual(r.payload.contractHealth.missing, [], 'webServer.register 已就绪，不得计入缺失')
})

test('(late-3) 重复 provide / 同实例二次注入 → register 次数稳定（同实例只挂一次）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true }, deferWebServer: true })
  await mount(ctx)
  state.provideWebServer()
  await settle()
  const afterFirst = state.routeRegistrations.length
  assert.equal(afterFirst, ENDPOINTS.length, '首次迟到挂载 = 四条路由')
  // 同一实例重复投递（防御性场景；真实 cordis 的服务重启=新实例，见 late-5）：
  // 幂等守卫必须拒绝重复注册
  state.provideWebServer()
  state.provideWebServer()
  await settle()
  assert.equal(state.routeRegistrations.length, afterFirst, '同一实例重复投递不得产生双注册（重复 register 的副作用/错误日志）')
  const r = await callRoute(state, STATS)
  assert.equal(r.code, 200, '守卫命中后端点必须仍然可用（不得因重复注册失败而降级）')
})

test('(late-4) 宿主无 ctx.inject 表面 → 回退一次性 ctx.get 挂载（既有行为保持）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true }, withoutInject: true })
  await mount(ctx)
  for (const path of ENDPOINTS) {
    assert.ok(state.routes.has(path), `无 ctx.inject 表面时必须回退 eager ctx.get 挂载 ${path}`)
  }
  const r = await callRoute(state, STATS)
  assert.equal(r.code, 200, '回退路径 stats 端点必须可读')
})

test('(late-5) 服务重启（新实例）→ 旧路由随 scope effect 销毁、新实例重挂', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true }, deferWebServer: true })
  await mount(ctx)
  state.provideWebServer()
  await settle()
  const firstHandlers = new Map(ENDPOINTS.map((path) => [path, state.routes.get(path)]))
  assert.equal(state.routeRegistrations.length, ENDPOINTS.length)
  state.restartWebServer() // 服务重启 = 新实例：旧 child effect 销毁 + 新实例重投递
  await settle()
  assert.equal(state.routeRegistrations.length, ENDPOINTS.length * 2, '新实例必须重挂四条路由（旧实例 disposer 已卸载）')
  for (const path of ENDPOINTS) {
    assert.ok(state.routes.has(path), `${path} 必须由新实例重新挂载`)
    assert.notEqual(state.routes.get(path), firstHandlers.get(path), `${path} 处理器必须来自新实例（旧 handler 不得残留）`)
  }
  const r = await callRoute(state, STATS)
  assert.equal(r.code, 200, '服务重启后 stats 端点必须仍可读')
})
