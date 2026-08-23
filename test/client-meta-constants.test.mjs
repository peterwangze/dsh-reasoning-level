/**
 * N1 源码常量元测试（// TDD-FAILS-UNTIL-N1 —— 当前会失败，Developer 修复后转绿）。
 *
 * 契约：客户端单模型抓取超时 ≥ 服务端单模型最坏时长 + 5s 余量。
 * 服务端最坏时长 = ceil(候选级数上界 / PROBE_CONCURRENCY) × PROBE_TIMEOUT_MS；
 * 候选级数上界取 LEVELS（目录声明可含全部 7 档；GENERATED_LEVELS 的 6 档为下界）。
 * 现状 PROBE_FETCH_TIMEOUT_MS=40000 < ceil(7/3)×30000+5000=95000 → 本用例期望失败。
 *
 * 说明：任务描述按 GENERATED_LEVELS（6 候选）给出 ≥65s 下界；本测试按源码常量
 * 精确推导，真实上界为 7 候选/3 波（95s）——任一修复（≥65s）满足任务要求但未满足
 * 本测试；Developer 以本测试为准（95s 或服务端整体限时/partial 返回替代方案，见 R1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function extractNumber(source, name) {
  const m = source.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)'))
  assert.ok(m, name + ' constant not found in source')
  return Number(m[1])
}

function extractArray(source, name) {
  const m = source.match(new RegExp('const ' + name + '\\s*=\\s*\\[([^\\]]*)\\]'))
  assert.ok(m, name + ' array not found in source')
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
}

test('(N1) 客户端 probe 抓取超时 ≥ 服务端单模型最坏时长+5s —  // TDD-FAILS-UNTIL-N1', () => {
  const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const clientTimeout = extractNumber(clientSrc, 'PROBE_FETCH_TIMEOUT_MS')
  const serverTimeout = extractNumber(indexSrc, 'PROBE_TIMEOUT_MS')
  const concurrency = extractNumber(indexSrc, 'PROBE_CONCURRENCY')
  const levelCeiling = extractArray(indexSrc, 'LEVELS').length
  const waves = Math.ceil(levelCeiling / concurrency)
  const requirement = waves * serverTimeout + 5000
  assert.ok(
    clientTimeout >= requirement,
    `client PROBE_FETCH_TIMEOUT_MS=${clientTimeout} < 服务端最坏 ${waves} 波 × ${serverTimeout}ms + 5s 余量 = ${requirement}ms（候选级数上界=${levelCeiling}，并发=${concurrency}）`
  )
})
