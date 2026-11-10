/**
 * FEAT-004 / 设计 §4.2 + §7.1：客户端 i18n zh/en 双字典必须成对。
 *
 * 客户端单文件自包含（lib/client.js 由宿主 makeRequire 加载），LANG 字典不可从
 * 外部 import；本测试对真实工件做源码级 key 集合对比——任一语言缺一个 key 即红，
 * 新增文案只改一边的回归在这里被确定性拦住。
 *
 * 断言：
 *  1. zh 与 en 的 key 集合完全相等（缺一即红、多一即红）；
 *  2. FEAT-004 五项的文案 key 在两侧都存在（searchEmpty / supportMatrixSummary /
 *     statsToolbarMeta / undoSucceeded+undoAction / persisted 三态）；
 *  3. LEVEL_LABELS 两语言均覆盖 7 个真实档位（follow 是哨兵，不计入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function dictBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `source blocks ${startMarker} / ${endMarker} must be locatable`)
  return source.slice(start, end)
}

function topLevelKeys(block) {
  // LANG 字典的 key 缩进固定 8 空格；值只有字符串/箭头函数，函数体内没有
  // 8 空格缩进的 `identifier:` 行，故该正则不引入嵌套键。
  return [...block.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
}

test('(FEAT-004/i18n-1) LANG zh 与 en 的 key 集合完全相等（缺一即红）', () => {
  const langBlock = dictBlock('const LANG = {', '\n    function makeT')
  const zhIndex = langBlock.indexOf('      zh: {')
  const enIndex = langBlock.indexOf('      en: {')
  assert.ok(zhIndex >= 0 && enIndex > zhIndex, 'LANG must contain zh then en dictionaries')
  const zhKeys = topLevelKeys(langBlock.slice(zhIndex, enIndex))
  const enKeys = topLevelKeys(langBlock.slice(enIndex))
  assert.ok(zhKeys.length > 100, `zh dictionary parsed too few keys (${zhKeys.length}) — parser drifted?`)
  assert.deepEqual(enKeys.sort(), zhKeys.sort(), 'en/zh key 集合必须逐项相等（新增文案必须两边同时加）')
})

test('(FEAT-004/i18n-2) FEAT-004 文案 key 在 zh/en 两侧都存在', () => {
  const langBlock = dictBlock('const LANG = {', '\n    function makeT')
  const zhIndex = langBlock.indexOf('      zh: {')
  const enIndex = langBlock.indexOf('      en: {')
  const zhKeys = new Set(topLevelKeys(langBlock.slice(zhIndex, enIndex)))
  const enKeys = new Set(topLevelKeys(langBlock.slice(enIndex)))
  const required = [
    'searchEmpty',
    'supportMatrixSummary',
    'statsToolbarMeta',
    'undoSucceeded',
    'undoAction',
    'persistedNotInConfigModel',
    'persistedOtherAdapter',
  ]
  for (const key of required) {
    assert.ok(zhKeys.has(key), `zh 字典缺 FEAT-004 key: ${key}`)
    assert.ok(enKeys.has(key), `en 字典缺 FEAT-004 key: ${key}`)
  }
})

test('(FEAT-004/i18n-3) LEVEL_LABELS 两语言均覆盖 7 档', () => {
  const block = dictBlock('const LEVEL_LABELS = {', 'const LEVEL_HINTS = {')
  const zhLine = block.split('\n').find((line) => line.includes('zh: {'))
  const enLine = block.split('\n').find((line) => line.includes('en: {'))
  assert.ok(zhLine !== undefined && enLine !== undefined, 'LEVEL_LABELS must carry zh/en lines')
  for (const level of LEVELS) {
    assert.ok(new RegExp('\\b' + level + ':').test(zhLine), `LEVEL_LABELS.zh 缺档位 ${level}`)
    assert.ok(new RegExp('\\b' + level + ':').test(enLine), `LEVEL_LABELS.en 缺档位 ${level}`)
  }
})

test('(UX-004/i18n-4) 工作台新增文案 key 在 zh/en 两侧都存在', () => {
  const langBlock = dictBlock('const LANG = {', '\n    function makeT')
  const zhIndex = langBlock.indexOf('      zh: {')
  const enIndex = langBlock.indexOf('      en: {')
  const zhKeys = new Set(topLevelKeys(langBlock.slice(zhIndex, enIndex)))
  const enKeys = new Set(topLevelKeys(langBlock.slice(enIndex)))
  const required = [
    'tabModels', 'tabDefaults', 'tabObservability', 'tabDiagnostics',
    'searchModels', 'filterProvider', 'onlyOverridden',
    'reasoningLevelShort', 'reasoningSourceMeasured', 'multimodal',
    'paramsTitle', 'paramOverride', 'hostActive', 'hostReserved', 'hostReservedHint',
    'resetModel', 'presetPrecise', 'presetBalanced', 'presetCreative', 'presetCustom', 'presetsTitle',
    'defaultParams', 'defaultParamsHint', 'modelsEmpty', 'modelsEmptyHint',
    'modelSource', 'followGlobal', 'custom', 'customSourceHint', 'rowFollowSummary', 'rowCustomSummary',
    'badgeEffort', 'badgeImage', 'badgeParam', 'overrideSummary',
    'effortFollowGlobal', 'defaultLevel', 'paramControlLabel', 'paramEffective', 'paramFollowGlobalAction', 'paramFollowHostAction',
    'inputFollowCatalog', 'inputCustomText', 'inputCustomImage', 'sourceEffective',
    'defaultsThinkingTitle', 'defaultsParamsTitle', 'overviewScope', 'unsetValue',
    'probeAll', 'probeAllHint', 'testingNote', 'probeNote', 'probeDone',
    'overviewThinkingDist', 'overviewMultimodal', 'overviewParamOverrides', 'overviewContract',
    'contractHealth', 'agentSelection', 'registryTitle', 'registryParams', 'registryModalities',
    'endpointStatus', 'probeState', 'observabilityHint', 'fallbackNotice', 'closeDetail',
    'paramInvalidNumber', 'paramInvalidRange',
  ]
  for (const key of required) {
    assert.ok(zhKeys.has(key), `zh 字典缺 UX-004 key: ${key}`)
    assert.ok(enKeys.has(key), `en 字典缺 UX-004 key: ${key}`)
  }
})

test('(UX-004/i18n-5) LEVEL_HINTS 7 档 zh/en 成对（等级文案唯一入口）', () => {
  const block = dictBlock('const LEVEL_HINTS = {', '// 语言一律由 t 携带')
  for (const level of LEVELS) {
    const start = block.indexOf('      ' + level + ': {')
    assert.ok(start >= 0, `LEVEL_HINTS 缺档位 ${level}`)
    const rest = block.slice(start)
    const next = rest.slice(1).search(/\n {6}[a-z]+: \{/)
    const section = next >= 0 ? rest.slice(0, next + 1) : rest
    assert.ok(section.includes('zh: {'), `LEVEL_HINTS.${level} 缺 zh`)
    assert.ok(section.includes('en: {'), `LEVEL_HINTS.${level} 缺 en`)
  }
})

/**
 * T-F4：key 集合相等还不够——空串或「英文侧直接抄中文」也会让 UI 在英文界面
 * 露出中文。这里把 LANG 对象字面量放进 vm 求值（值只有字符串/箭头函数），
 * 对所有字符串值做非空 + zh !== en 检查；函数/嵌套对象值跳过（但两侧
 * 类型必须一致），避免把 persistedShort 这类状态表误当文案。
 *
 * 白名单只允许**确属专有名词/双臂有意相同**的 key；当前字典没有同值项，
 * 故为空。新增同值文案必须显式登记，否则这里判红（避免把已有合法同值 key
 * 误判——白名单是显式清单，不是按值模糊放行）。
 */
const SAME_VALUE_ALLOWLIST = new Set([])

function langDictionaries() {
  const langBlock = dictBlock('const LANG = {', '\n    function makeT')
  const objectLiteral = langBlock.slice(langBlock.indexOf('{'))
  const lang = vm.runInNewContext('(' + objectLiteral + ')', Object.create(null), { timeout: 1000 })
  assert.ok(lang !== null && typeof lang === 'object' && lang.zh !== undefined && lang.en !== undefined, 'LANG literal must evaluate to { zh, en }')
  return lang
}

test('(UX-004/i18n-6) LANG 值质量：字符串非空且 zh/en 不互相抄写（专有名词白名单例外）', () => {
  const lang = langDictionaries()
  const zhKeys = Object.keys(lang.zh)
  const enKeys = Object.keys(lang.en)
  assert.deepEqual(enKeys.sort(), zhKeys.sort(), 'value-quality check requires identical key sets')
  const problems = []
  for (const key of zhKeys) {
    const zh = lang.zh[key]
    const en = lang.en[key]
    if (typeof zh !== 'string' || typeof en !== 'string') {
      assert.equal(typeof zh, typeof en, `LANG.${key} 的值类型在 zh/en 不一致`)
      continue
    }
    if (zh.trim() === '') problems.push(key + ': zh 为空')
    if (en.trim() === '') problems.push(key + ': en 为空')
    if (zh === en && !SAME_VALUE_ALLOWLIST.has(key)) problems.push(key + ': zh 与 en 相同（' + JSON.stringify(zh) + '）')
  }
  assert.deepEqual(problems, [], 'i18n 值质量问题（空串/英文抄中文）；确属专有名词请登记 SAME_VALUE_ALLOWLIST')
})
