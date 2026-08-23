/**
 * 403 门控（R1 §2 覆盖缺口）+ 回环放行矩阵。
 *
 * statsPublic=false（默认）时仅回环 Host 可读统计与探测端点；非回环 Host 一律
 * 403，除非 statsPublic=true 显式放行（LAN 部署）。403 响应为 text/plain，
 * callRoute 将其折叠为 payload.text。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute } from './harness.mjs'

test('(gate-1) stats 端点：非回环 Host + statsPublic=false → 403', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false } })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats', {}, '192.168.1.10')
  assert.equal(r.code, 403)
  assert.match(r.payload.text, /loopback-only/)
})

test('(gate-2) stats 端点：非回环 Host + statsPublic=true → 200', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats', {}, '10.0.0.5')
  assert.equal(r.code, 200)
  assert.equal(typeof r.payload.totalCalls, 'number')
})

test('(gate-3) probe/test/apply 端点：非回环 Host + statsPublic=false → 403（三端点参数化）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false } })
  await mount(ctx)
  for (const path of ['/reasoning-level-stats/probe', '/reasoning-level-stats/probe/apply', '/reasoning-level-stats/test']) {
    const r = await callRoute(state, path, {}, '192.168.1.10')
    assert.equal(r.code, 403, path)
    assert.equal(r.payload.text, 'forbidden', path)
  }
})

test('(gate-4) 回环 Host 变体（IPv4/localhost 形式）→ 放行 200；非回环域名 → 403', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false } })
  await mount(ctx)
  for (const host of ['localhost', 'localhost:8080', '127.0.0.1', '127.0.0.1:3000']) {
    const r = await callRoute(state, '/reasoning-level-stats', {}, host)
    assert.equal(r.code, 200, host)
  }
  const r = await callRoute(state, '/reasoning-level-stats', {}, 'example.com')
  assert.equal(r.code, 403)
})

test('(gate-5) IPv6 回环 Host 放行 —  // TDD-FAILS-UNTIL-FIX-001（已转绿）：isLoopbackHost 的 host.split(\':\')[0] 对 "[::1]" 返回 "[", IPv6 形式永不匹配（缺陷 DEF-001），DEV-003 按 WHATWG URL 归一化修复；标注保留为守卫语义', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false } })
  await mount(ctx)
  for (const host of ['[::1]', '[::1]:8080', '::1']) {
    const r = await callRoute(state, '/reasoning-level-stats', {}, host)
    assert.equal(r.code, 200, host + ' 应为回环放行（当前 403=缺陷 DEF-001）')
  }
})

test('(gate-d1) Host 头恶意形态（userinfo/path/fragment）—  // TDD-FAILS-UNTIL-FIX-D1（已转绿）：URL 归一化吞没 userinfo/path/fragment——127.0.0.1/x、x@127.0.0.1、127.0.0.1#y 均归一化为 127.0.0.1 而放行（统计/探测端点的安全边界回归 D1）；字符集预检修复后转绿，标注保留为守卫语义', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false } })
  await mount(ctx)
  for (const host of ['127.0.0.1/x', 'x@127.0.0.1', '127.0.0.1#y']) {
    const r = await callRoute(state, '/reasoning-level-stats', {}, host)
    assert.equal(r.code, 403, host + ' 应被拒绝（当前放行=缺陷 D1）')
  }
})
