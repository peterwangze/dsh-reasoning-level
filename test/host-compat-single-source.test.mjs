/**
 * FEAT-001 单源一致性守护（设计 §3.2 方案 A / §4.2 条目 8+9 / BM-4）。
 *
 * 守护对象：lib/client.js 内嵌镜像段（SINGLE-SOURCE-MIRROR）与
 * lib/host-compat.js 的 HOST_REMOTE_CONTRACT 必须逐字段一致——客户端面因
 * 宿主 makeRequire 无文件系统解析（dsh-client-modules L300-310 实证，
 * `require('./host-compat.js')` 必死）无法共享导入，物理上是两份拷贝；
 * 本测试是锚定两平面一致的唯一机器防线：任何一侧漂移即 CI 红。
 *
 * 零环境依赖（BM-4 硬约束）：两个工件都是仓库内文件，经各自真实加载契约
 * 读取——客户端面经 window.__ModuleLoader__（vm，与 scripts/client-smoke.mjs
 * / client-host-face-compat.test.mjs 同一契约）、服务端面经 Node ESM 原生
 * import。不读 DSH_HOST_TREE、不读任何环境变量、无条件 skip——CI 恒跑恒断言。
 *
 * 同 commit 纪律（编程要求 4）：镜像段改动必须与 lib/host-compat.js 在同一
 * 变更单元内提交；本测试红 = 该纪律被破坏或宿主契约适配只改了一侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { HOST_REMOTE_CONTRACT } from '../lib/host-compat.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 平面①：客户端真实工件经其自身 ModuleLoader 契约加载（vm 双面加载器）──
let loaded = null
const sandbox = { window: { __ModuleLoader__: { load(def) { loaded = def } } } }
vm.runInNewContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
assert.ok(loaded !== null && loaded.id === 'dsh-reasoning-level', 'client.js 必须经 __ModuleLoader__ 契约捕获（C1 形态契约隐式守护）')

/**
 * 从捕获的工厂函数源码中提取镜像段对象字面量并在 vm 中求值。
 * 扫描器为字符串感知（跳过引号内字符，含转义），正确处理
 * responseEnvelope/legacyEnvelope 值内部的 "{" "}" 字符。
 * 提取源是 loaded.factory.toString()——镜像段若被挪出工厂体（cordis 入口
 * 契约要求它留在 client.js 工厂内），此处即找不到声明而红。
 */
function extractMirrorLiteral(factorySource) {
  const markerIndex = factorySource.indexOf('SINGLE-SOURCE-MIRROR')
  assert.ok(markerIndex !== -1, '工厂内必须存在 SINGLE-SOURCE-MIRROR 标记段（BM-4 机器可检标记锚）')
  const declIndex = factorySource.indexOf('const HOST_REMOTE_CONTRACT', markerIndex)
  assert.ok(declIndex !== -1, '标记段之后必须存在 const HOST_REMOTE_CONTRACT 声明（镜像段形态：标记 + 数据字面量）')
  const openIndex = factorySource.indexOf('{', declIndex)
  let depth = 0
  let quote = null
  for (let i = openIndex; i < factorySource.length; i++) {
    const ch = factorySource[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = factorySource.slice(openIndex, i + 1)
        return vm.runInNewContext('(' + literal + ')', {}, { filename: 'client-mirror.extract' })
      }
    }
  }
  assert.fail('HOST_REMOTE_CONTRACT 对象字面量未闭合（字符串感知括号扫描到工厂源码尾）')
}

test('(FEAT-001/BM-4) 客户端镜像段 === host-compat HOST_REMOTE_CONTRACT（deep-equal，任何一侧漂移即红）', () => {
  const mirror = extractMirrorLiteral(loaded.factory.toString())
  // vm 沙箱对象与主 realm 原型域不同，deepStrictEqual 直接比较会误报（先例：
  // client-host-face-compat 的 mutate ops 断言注释）——两侧经 JSON 归一化后
  // 比较；HOST_REMOTE_CONTRACT 是纯数据（字符串/数字/数组/普通对象），归一化无损。
  assert.deepEqual(
    JSON.parse(JSON.stringify(mirror)),
    JSON.parse(JSON.stringify(HOST_REMOTE_CONTRACT)),
    'client.js SINGLE-SOURCE-MIRROR 段与 lib/host-compat.js HOST_REMOTE_CONTRACT 必须逐字段一致——'
      + 'dsh 升级适配必须与 host-compat.js 同一变更单元同步修改（设计 §3.3 / BM-4 同 commit 纪律）',
  )
})

test('(FEAT-001/BM-4) SINGLE-SOURCE-MIRROR 标记段存在于 client.js 工厂内（删除标记或挪出工厂 = 红）', () => {
  const factorySource = loaded.factory.toString()
  assert.match(factorySource, /SINGLE-SOURCE-MIRROR/, '工厂源码必须携带机器可检标记 SINGLE-SOURCE-MIRROR——它是条目 8 标记锚与 Review 检查单的锚定点')
})

test('(FEAT-001/条目8/C1) client.js require 调用集合 === [react]（唯一平台 seed 词，无本地相对 require）', () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const required = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
  assert.deepEqual(
    [...new Set(required)].sort(),
    ['react'],
    '客户端 bundle 形态契约（C1）：工厂 CJS 的 require 域仅平台 seed 词 react——'
      + '出现任何其他名字（尤其本地相对路径）= makeRequire "missed the module table" = 页面死（dsh-client-modules L300-310）',
  )
})
