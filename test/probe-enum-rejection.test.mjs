/**
 * 枚举式拒绝归类（2026-10-21 真机反馈，EVD-068）：
 *
 * 聚合网关对 `minimal` 的响应是
 *   `INVALID_REQUEST 400: {"message":"Invalid option: expected one of
 *    \"off\"|\"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\""}`
 * —— 语义是「这一档不被接受」，但旧判据只认 `reasoning effort "X"` 字样，于是它落进
 * `blocked`（「其他错误」），UI 把整段 JSON 铺在表格里（用户截图实证）。
 *
 * 本测试锁定三条判据边界：
 *  enum-1 枚举里不含被请求档 → rejected（明确不支持）；
 *  enum-2 枚举里**含**被请求档 → 仍 blocked（说明失败不是档位问题，别乱下结论）；
 *  enum-3 枚举里的 effort 词 < 3 个 → 不归类（防止把别的字段枚举误当 effort 枚举）；
 *  enum-4 传输类错误 → 仍 blocked（不能被枚举规则吞掉）。
 *
 * 每一条都是「旧实现会判错」的形态，因此可判别（改坏即红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, statusChunks } from './harness.mjs'

/** 网关真实的枚举式拒绝文案（引号会经 JSON 转义两层，这里给出解析后的消息体）。 */
const ENUM_WITHOUT_MINIMAL = '{"message":"Invalid option: expected one of \\"off\\"|\\"low\\"|\\"medium\\"|\\"high\\"|\\"xhigh\\"|\\"max\\""}'
const ENUM_WITH_MINIMAL = '{"message":"Invalid option: expected one of \\"minimal\\"|\\"low\\"|\\"medium\\"|\\"high\\""}'
const ENUM_TOO_FEW = '{"message":"Invalid option: expected one of \\"low\\"|\\"high\\""}'

function mountProbe(failLevel, code, message) {
  return makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm' }] } } },
    resolveModelInfo: async () => undefined,
    stream: (opts) => (opts.reasoningEffort === failLevel
      ? statusChunks({ kind: 'error', failure: { code, message } })(opts)
      : statusChunks({ kind: 'stop', failure: null })(opts)),
  })
}

test('(enum-1) 枚举不含被请求档 → rejected（不是 blocked）', async () => {
  const { ctx, state } = mountProbe('minimal', 'INVALID_REQUEST', ENUM_WITHOUT_MINIMAL)
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.ok(r.payload.rejected.includes('minimal'), 'minimal 应归入 rejected，实际 rejected=' + JSON.stringify(r.payload.rejected))
  assert.equal(r.payload.blocked.includes('minimal'), false, 'minimal 不应再出现在 blocked')
  assert.equal(r.payload.blockedReasons.minimal, undefined, 'rejected 档位不写 blockedReasons')
})

test('(enum-2) 枚举里含被请求档 → 仍 blocked（失败与档位无关，不臆断）', async () => {
  const { ctx, state } = mountProbe('minimal', 'INVALID_REQUEST', ENUM_WITH_MINIMAL)
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.ok(r.payload.blocked.includes('minimal'), 'minimal 应留在 blocked')
  assert.equal(r.payload.rejected.includes('minimal'), false)
})

test('(enum-3) 枚举里的 effort 词 < 3 → 不归类（防别的字段枚举误判）', async () => {
  const { ctx, state } = mountProbe('minimal', 'INVALID_REQUEST', ENUM_TOO_FEW)
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.ok(r.payload.blocked.includes('minimal'), '证据不足时应保守归 blocked')
  assert.equal(r.payload.rejected.includes('minimal'), false)
})

test('(enum-4) 传输类错误 → 仍 blocked（不被枚举规则吞掉）', async () => {
  const { ctx, state } = mountProbe('minimal', 'TRANSPORT', 'TRANSPORT: Connection error.')
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.ok(r.payload.blocked.includes('minimal'))
  assert.equal(r.payload.rejected.includes('minimal'), false)
  assert.equal(r.payload.blockedReasons.minimal.code, 'TRANSPORT')
})
