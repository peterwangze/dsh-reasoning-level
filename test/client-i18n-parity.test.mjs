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
