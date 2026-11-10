/**
 * N1 源码常量元测试（// TDD-GUARD-N1，原 TDD-FAILS-UNTIL-N1，已修复转绿，回归即红）。
 *
 * 契约：客户端单模型抓取超时 ≥ 服务端单模型最坏时长 + 5s 余量。
 * 服务端最坏时长 = ceil(候选级数上界 / PROBE_CONCURRENCY) × PROBE_TIMEOUT_MS；
 * 候选级数上界取 LEVELS（目录声明可含全部 7 档；GENERATED_LEVELS 的 6 档为下界）。
 * 现状 PROBE_FETCH_TIMEOUT_MS=95000 ≥ ceil(7/3)×30000+5000=95000 → 转绿；回归时失败
 * 即提示常量契约被破坏（守卫语义）。
 *
 * 说明：任务描述按 GENERATED_LEVELS（6 候选）给出 ≥65s 下界；本测试按源码常量
 * 精确推导，真实上界为 7 候选/3 波（95s），开发者按本测试修复（N1，DEV-003）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

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

test('(N1) 客户端 probe 抓取超时 ≥ 服务端单模型最坏时长+5s —  // TDD-GUARD-N1', () => {
  const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const clientTimeout = extractNumber(clientSrc, 'PROBE_FETCH_TIMEOUT_MS')
  const serverTimeout = extractNumber(indexSrc, 'PROBE_TIMEOUT_MS')
  const concurrency = extractNumber(indexSrc, 'PROBE_CONCURRENCY')
  const levelCeiling = extractArray(indexSrc, 'THINKING_LEVEL_VOCABULARY').length
  const waves = Math.ceil(levelCeiling / concurrency)
  const requirement = waves * serverTimeout + 5000
  assert.ok(
    clientTimeout >= requirement,
    `client PROBE_FETCH_TIMEOUT_MS=${clientTimeout} < 服务端最坏 ${waves} 波 × ${serverTimeout}ms + 5s 余量 = ${requirement}ms（候选级数上界=${levelCeiling}，并发=${concurrency}）`
  )
})

// ── UX-004：工作台常量契约（端点路径 / 四视图 / 预设值 / fallback 注册表 / 样式）──
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

function extractArrayLiteral(source, name) {
  const marker = 'const ' + name + ' = '
  const start = source.indexOf(marker)
  assert.ok(start >= 0, name + ' declaration not found')
  const bracket = source.indexOf('[', start)
  assert.ok(bracket >= 0, name + ' array literal not found')
  const end = source.indexOf(']', bracket)
  assert.ok(end > bracket, name + ' array literal is unterminated')
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.slice(bracket, end + 1) + ')')))
}

function extractObjectLiteral(source, name) {
  const marker = 'const ' + name + ' = '
  const start = source.indexOf(marker)
  assert.ok(start >= 0, name + ' declaration not found')
  const brace = source.indexOf('{', start)
  assert.ok(brace >= 0, name + ' object literal not found')
  // 该常量只含数据字面量（labelKey/params），按顶层括号配对截取。
  let depth = 0
  let end = -1
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  assert.ok(end > brace, name + ' object literal is unterminated')
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.slice(brace, end + 1) + ')')))
}

test('(UX-004/meta-1) 端点路径与四视图顺序是设计 §6/§7 常量', () => {
  const match = clientSource.match(/const MODEL_ENDPOINT_PATH = '([^']+)'/)
  assert.ok(match, 'MODEL_ENDPOINT_PATH constant missing')
  assert.equal(match[1], '/reasoning-level-models')
  assert.deepEqual(extractArrayLiteral(clientSource, 'VIEW_TABS'), ['models', 'defaults', 'observability', 'diagnostics'])
})

test('(UX-004/meta-1b) 工作台按容器宽度（1000px）切换窄布局，而非只看 viewport', () => {
  assert.equal(extractNumber(clientSource, 'WORKBENCH_COMPACT_WIDTH'), 1000)
  assert.ok(clientSource.includes('ResizeObserver'), 'container measurement must use ResizeObserver')
  assert.ok(/setCompact\(width < WORKBENCH_COMPACT_WIDTH\)/.test(clientSource), 'measurement must compare container width to the compact threshold')
  assert.ok(clientSource.includes('rl-workbench-single'), 'no-selection workbench must not reserve the detail column')
})

test('(UX-004/meta-2) 内置预设值与设计 §3 常量表一致', () => {
  const presets = extractObjectLiteral(clientSource, 'PARAM_PRESETS')
  assert.deepEqual(Object.keys(presets), ['precise', 'balanced', 'creative'])
  assert.deepEqual(presets.precise.params, { temperature: 0.2, topP: 0.9, topK: 20 })
  assert.deepEqual(presets.balanced.params, { temperature: 0.7, topP: 0.95, topK: 40 })
  assert.deepEqual(presets.creative.params, { temperature: 1, topP: 1, topK: 0 })
  assert.equal(presets.precise.labelKey, 'presetPrecise')
})

test('(UX-004/meta-3) fallback 注册表：temperature/maxTokens 生效，topP/topK 预留并带原因', () => {
  const start = clientSource.indexOf('const FALLBACK_PARAMS = ')
  const end = clientSource.indexOf('\n    const PARAM_PRESETS = ', start)
  assert.ok(start >= 0 && end > start, 'FALLBACK_PARAMS block must be locatable')
  const block = clientSource.slice(start, end)
  const section = (id) => {
    const from = block.indexOf("id: '" + id + "'")
    assert.ok(from >= 0, 'fallback param missing: ' + id)
    const next = block.indexOf("id: '", from + 1)
    return block.slice(from, next > 0 ? next : block.length)
  }
  assert.match(section('temperature'), /hostSupport: HOST_ACTIVE/)
  assert.match(section('maxTokens'), /hostSupport: HOST_ACTIVE/)
  assert.match(section('topP'), /hostSupport: HOST_RESERVED/)
  assert.match(section('topP'), /DSH 0\.2\.2 GenerateOptions has no topP field/)
  assert.match(section('topK'), /hostSupport: HOST_RESERVED/)
  assert.match(section('topK'), /DSH 0\.2\.2 GenerateOptions has no topK field/)
  assert.match(clientSource, /const HOST_ACTIVE = 'active'/)
  assert.match(clientSource, /const HOST_RESERVED = 'reserved'/)
})

test('(UX-004/meta-4) 样式保留 focus-visible / reduced-motion，并含工作台关键类', () => {
  for (const needle of [':focus-visible', '@media (prefers-reduced-motion: reduce)', '.rl-tabs', '.rl-tab-active', '.rl-model-row', '.rl-detail', '.rl-param-row', '.rl-preset']) {
    assert.ok(clientSource.includes(needle), 'stylesheet missing ' + needle)
  }
  assert.ok(clientSource.includes('table-layout: fixed'), 'legacy table layout contract must stay')
})
