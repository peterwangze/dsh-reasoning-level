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
 * FEAT-002：镜像段提取器/工厂加载器/require 集判据收敛到 test/host-probes.mjs
 * 唯一实现点（doctor 与测试判据零分叉），本文件消费之；断言按 R-2
 * （REVIEW-FEAT-001-R1）收紧为 deepStrictEqual。镜像域自 R-1 起含 namespaces
 * 字段（值 = HOST_NAMESPACES 镜像数据）——ns 漂移同样在此红。
 *
 * 同 commit 纪律（编程要求 4）：镜像段改动必须与 lib/host-compat.js 在同一
 * 变更单元内提交；本测试红 = 该纪律被破坏或宿主契约适配只改了一侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HOST_REMOTE_CONTRACT } from '../lib/host-compat.js'
import { loadClientFactory, extractMirrorLiteral, clientRequireSet } from './host-probes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 平面①：客户端真实工件经其自身 ModuleLoader 契约加载（vm 双面加载器）──
const loaded = loadClientFactory()

test('(FEAT-001/BM-4) 客户端镜像段 === host-compat HOST_REMOTE_CONTRACT（deepStrictEqual，任何一侧漂移即红）', () => {
  const mirror = extractMirrorLiteral(loaded.factory.toString())
  // vm 沙箱对象与主 realm 原型域不同，deepStrictEqual 直接比较会误报（先例：
  // client-host-face-compat 的 mutate ops 断言注释）——两侧经 JSON 归一化后
  // 比较；HOST_REMOTE_CONTRACT 是纯数据（字符串/数字/数组/普通对象），归一化无损。
  // R-2（REVIEW-FEAT-001-R1）：deepEqual → deepStrictEqual 收紧——JSON 产物上
  // 额外防跨型巧合（如 arity 1 vs '1'）。
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(mirror)),
    JSON.parse(JSON.stringify(HOST_REMOTE_CONTRACT)),
    'client.js SINGLE-SOURCE-MIRROR 段与 lib/host-compat.js HOST_REMOTE_CONTRACT 必须逐字段一致——'
      + 'dsh 升级适配必须与 host-compat.js 同一变更单元同步修改（设计 §3.3 / BM-4 同 commit 纪律）；'
      + '镜像域含 namespaces（R-1）——命名空间漂移同样在此红',
  )
})

test('(FEAT-001/BM-4) SINGLE-SOURCE-MIRROR 标记段存在于 client.js 工厂内（删除标记或挪出工厂 = 红）', () => {
  const factorySource = loaded.factory.toString()
  assert.match(factorySource, /SINGLE-SOURCE-MIRROR/, '工厂源码必须携带机器可检标记 SINGLE-SOURCE-MIRROR——它是条目 8 标记锚与 Review 检查单的锚定点')
})

test('(FEAT-001/条目8/C1) client.js require 调用集合 === [react]（唯一平台 seed 词，无本地相对 require）', () => {
  const required = clientRequireSet(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))
  assert.deepEqual(
    required,
    ['react'],
    '客户端 bundle 形态契约（C1）：工厂 CJS 的 require 域仅平台 seed 词 react——'
      + '出现任何其他名字（尤其本地相对路径）= makeRequire "missed the module table" = 页面死（dsh-client-modules L300-310）',
  )
})
