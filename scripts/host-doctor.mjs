/**
 * host-doctor — DSH 宿主兼容面诊断（FEAT-002，设计 §4.3 / DEC-018 ④）。
 *
 * 用途：dsh 升级后第一步——一条命令输出逐触点 PASS/FAIL/DRIFT/SKIP + 宿主版本
 * 清单 + 漂移定位建议。与判别测试共用同一探针模块 test/host-probes.mjs
 * （测试绿 ⟺ doctor 绿，判据零分叉）。全程只读，零写入零网络。
 *
 *   node scripts/host-doctor.mjs [--tree <宿主树>]
 *   npm run host:doctor [--tree <宿主树>]
 *
 * 目标树解析顺序（§4.3）：--tree > DSH_HOST_TREE（旧名 DSH_HOST_PACKAGES 为
 * 别名）> resolveDshHomeSafe()（lib/host-compat.js 单源导出，F-3）下的
 * profiles/node_modules。--tree 接受 profiles 目录或其 node_modules。
 * 目标树若是本仓库自身 node_modules（devDeps 锁版基线）→ 按 baseline 分级
 * （T 级失败 = FAIL：锁版不该漂）；否则按 live 分级（T 级失败 = DRIFT：BM-2
 * 防误报，等待人工语义复核）。
 *
 * 退出码：0 = 无 FAIL（DRIFT 允许 0 但醒目输出）；1 = 存在 FAIL；
 * 2 = 目标树不可解析（列出解析链与已扫描候选）或宿主契约面零断言执行
 * （宿主树探针零执行——本身就是异常，BM-3；判定与测试同源 doctorExit）。
 *
 * @module dsh-reasoning-level/scripts/host-doctor
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveDshHomeSafe } from '../lib/host-compat.js'
import {
  baselineSource, liveSourceFromEnv, normalizeTreeRoot, runBattery,
  hostVersionManifest, provenanceFor, doctorExit,
} from '../test/host-probes.mjs'

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 参数解析（仅 --tree；多余/未知参数按用法错误处理）──────────────────────
function parseArgs(argv) {
  const out = { tree: undefined, errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tree') {
      const value = argv[i + 1]
      if (value === undefined || value === '') out.errors.push('--tree 需要一个路径参数')
      else { out.tree = value; i += 1 }
    } else if (arg.startsWith('--tree=')) {
      const value = arg.slice('--tree='.length)
      if (value === '') out.errors.push('--tree= 需要一个路径参数')
      else out.tree = value
    } else if (arg === '--help' || arg === '-h') {
      out.help = true
    } else {
      out.errors.push(`未知参数：${arg}（仅支持 --tree <path>）`)
    }
  }
  return out
}

const USAGE = '用法：node scripts/host-doctor.mjs [--tree <profiles 目录或其 node_modules>]（环境变量 DSH_HOST_TREE / DSH_HOST_PACKAGES 亦可指定）'

// ── 目标树解析（§4.3 顺序）─────────────────────────────────────────────────
// MAINT-030/F-2：scanned 解析链（原始输入→归一化）在**全部**分支透传——此前
// --tree / DSH_HOST_TREE / 别名三分支 push 后丢弃（死 push），坏树输出回退仅
// 显示归一化根，丢失诊断链。doctor 消费方：坏树 exit 2 与零执行 exit 2 输出。
function resolveTargetTree(cliTree) {
  const scanned = []
  if (cliTree !== undefined) {
    const root = normalizeTreeRoot(cliTree)
    scanned.push(`原始输入 --tree ${cliTree} → 归一化 ${root}`)
    return { root, origin: '--tree', scanned }
  }
  const envSource = liveSourceFromEnv({ DSH_HOST_TREE: process.env.DSH_HOST_TREE, DSH_HOST_PACKAGES: process.env.DSH_HOST_PACKAGES })
  if (process.env.DSH_HOST_TREE !== undefined && process.env.DSH_HOST_TREE !== '') {
    const root = normalizeTreeRoot(process.env.DSH_HOST_TREE)
    scanned.push(`原始输入 DSH_HOST_TREE=${process.env.DSH_HOST_TREE} → 归一化 ${root}`)
    return { root, origin: 'DSH_HOST_TREE', scanned }
  }
  if (envSource !== null && envSource.via.includes('别名')) {
    scanned.push(`原始输入 DSH_HOST_PACKAGES=${process.env.DSH_HOST_PACKAGES}（别名）→ 归一化 ${envSource.root}`)
    return { root: envSource.root, origin: 'DSH_HOST_PACKAGES(别名)', scanned }
  }
  const home = resolveDshHomeSafe()
  if (home === undefined) {
    scanned.push('原始输入 resolveDshHomeSafe() = undefined（DSH_HOME 未设置且 homedir 不可用）')
    return { root: null, origin: '缺省解析失败', scanned }
  }
  const root = join(home, 'profiles', 'node_modules')
  scanned.push(`原始输入 resolveDshHomeSafe() = ${home} → 归一化 ${root}`)
  return { root, origin: `缺省解析（${home} 下 profiles/node_modules）`, scanned }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}
if (args.errors.length > 0) {
  console.error(`host-doctor: 参数错误——${args.errors.join('；')}\n${USAGE}`)
  process.exit(2)
}

const target = resolveTargetTree(args.tree)
const lines = []
const push = (s = '') => lines.push(s)

push('dsh-reasoning-level host-doctor（FEAT-002 宿主兼容面诊断，设计 §4.3）')
push(`目标树：${target.root ?? '（不可解析）'}（来源：${target.origin}）`)

// 树可解析性（exit 2 判定①）：目录不存在 / 无 @deepseek-ai 作用域 = 不可解析
let rootExists = false
let scopedExists = false
if (target.root !== null) {
  rootExists = existsSync(target.root)
  scopedExists = rootExists && existsSync(join(target.root, '@deepseek-ai'))
}
const treeUsable = rootExists && scopedExists
if (!treeUsable) {
  push('')
  push('✗ 目标树不可解析——解析链（原始输入→归一化）与已扫描候选：')
  for (const s of target.scanned) push(`  - ${s}`)
  push(`  - 已扫描候选：${target.root ?? '(解析失败无根)'}（根目录${rootExists ? '存在' : '不存在'}，@deepseek-ai/ 作用域${scopedExists ? '存在' : '不存在'}）`)
  push('  处置：dsh plugin 安装后的标准布局为 <DSH home>/profiles/node_modules（含 @deepseek-ai/*）；')
  push('  若布局变化（BM-3），用 --tree 显式指向含 @deepseek-ai/ 的 node_modules 目录。')
  console.log(lines.join('\n'))
  process.exit(2)
}

// 分级：目标树 === 本仓库 node_modules（realpath 归一）→ baseline（T 级失败=FAIL）
const baselineRootReal = realpathSync(baselineSource().root)
let grading = 'live'
let targetReal = target.root
try { targetReal = realpathSync(target.root) } catch { /* 保持原样 */ }
if (targetReal === baselineRootReal) grading = 'baseline'
const source = grading === 'baseline'
  ? { kind: 'baseline', label: `devDeps 锁版基线（${target.root}）`, root: target.root }
  : { kind: 'live', label: `活树（${target.root}）`, root: target.root }

push(`分级：${grading === 'baseline' ? 'baseline——目标树即 devDeps 锁版基线，T 级失败 = FAIL（锁版不该漂）' : 'live——T 级失败 = DRIFT（BM-2 防误报，等待人工语义复核）'}`)
push('')

// ── 逐触点表（§4.2 十一条，探针与判别测试共用）────────────────────────────
// MAINT-030/F-3：baseline 分级的 fail-closed throw（包缺席/版本失配，探针模块
// requirePackage 抛出）在此结构化承接——替代原始栈迹崩溃 exit 1。载荷自带
// 版本失配值（已安装 vs devDeps 锁版）与处置命令提示（ci.yml 同款 npm ci）。
let results
try {
  results = await runBattery(source)
} catch (error) {
  push('')
  push(`✗ 探针电池 fail-closed 中止——${error?.message ?? error}`)
  push('  （工件源① devDeps 锁版基线解析失败即整体中止：exit 2；按上方处置命令修复后重跑。）')
  console.log(lines.join('\n'))
  process.exit(2)
}
push('逐触点表（设计 §4.2 断言清单）：')
const symbol = { PASS: '✓', FAIL: '✗', DRIFT: '⚠', SKIP: '-' }
for (const r of results) {
  const marker = r.skip === 'UNRESOLVED' ? 'SKIP-UNRESOLVED' : r.status
  push(`  #${String(r.id).padStart(2)} [${symbol[r.status] ?? ' '} ${marker}] ${r.touchpoint}`)
  if (r.status === 'SKIP') push(`      原因：${r.skipReason}`)
  else if (r.evidence) push(`      证据：${r.evidence}`)
}

// SKIP-UNRESOLVED 醒目汇总（BM-3：包不可解析 ≠ 契约 FAIL——先确认布局，不做契约判断）
const unresolved = results.filter((r) => r.skip === 'UNRESOLVED')
if (unresolved.length > 0) {
  push('')
  push(`⚠ 以下 ${unresolved.length} 条触点因包在目标树不可解析而 SKIP-UNRESOLVED——先确认树布局，不做契约判断：`)
  for (const r of unresolved) push(`  - #${r.id} ${r.touchpoint}（${r.skipReason}）`)
}

// ── 宿主版本清单（§4.3 输出②）──────────────────────────────────────────────
const manifest = hostVersionManifest(source)
push('')
push(`宿主版本清单（目标树 @deepseek-ai/*，共 ${manifest.length} 项）：`)
for (const { name, version } of manifest) push(`  ${name}@${version}`)
if (manifest.length === 0) push('  （无——目标树 @deepseek-ai/ 作用域为空）')

// ── FAIL/DRIFT 漂移定位建议（§4.3 输出③）──────────────────────────────────
const problems = results.filter((r) => r.status === 'FAIL' || r.status === 'DRIFT')
if (problems.length > 0) {
  push('')
  push('漂移定位建议（逐 FAIL/DRIFT）：')
  for (const r of problems) {
    push(`  #${r.id} [${r.status}] ${r.touchpoint}`)
    if (r.evidence) push(`    证据：${r.evidence}`)
    if (r.hint) push(`    提示：${r.hint}`)
    const rows = provenanceFor(r.touchpoint)
    for (const row of rows) push(`    出处台账：${row.package} ${row.anchor}（已验证版本：${row.verified.join(', ') || '—'}）`)
    push('    下一步：① 查上述出处台账 anchor 的宿主源码位置 → ② 在目标树对应包全文搜索锚串旧变体 →')
    push('             ③ 若宿主已改名/移位，查宿主 changelog / 相邻版本 diff，更新 host-compat.js + client.js 镜像段（同一变更单元）+ devDeps 锁版。')
  }
}

// ── 摘要与退出码 ───────────────────────────────────────────────────────────
const count = (status) => results.filter((r) => r.status === status).length
push('')
push(`摘要：PASS=${count('PASS')}  FAIL=${count('FAIL')}  DRIFT=${count('DRIFT')}  SKIP=${count('SKIP')}（共 ${results.length} 条）`)

// MAINT-030/F-1+T-F1 收口：退出判定与判别测试同源消费 doctorExit（探针模块
// 唯一实现点，零分叉）——executed 仅计 requiresHostTree 条目，自有工件探针
//（#8/9/11）不再计入该守卫。宿主契约面零断言执行（如空作用域树全部
// SKIP-UNRESOLVED）= exit 2，溜号窗口（FEAT-002-R0 impl F-1 / test T-F1）关闭。
const verdict = doctorExit(results)
if (count('DRIFT') > 0 && !verdict.hasFail) {
  push(`⚠ 存在 ${count('DRIFT')} 条 DRIFT：exit 0 放行，但须按 VERIFICATION.md「DRIFT 复核 SOP」处置（复核 → 更新锚点/锚串 → 一个 commit）——长期搁置会导致 T 级锚点腐烂（BM-2 残余风险）。`)
}
if (verdict.hostExecuted === 0) {
  push('✗ 宿主契约面零断言执行（宿主树探针全部 SKIP，自有工件探针不计入本守卫）——本身就是 exit 2 级异常（BM-3：doctor 永不输出「全绿但宿主契约面零判定」）。')
  push('  已扫描路径：')
  for (const s of target.scanned) push(`  - ${s}`)
  push(`  - 已扫描候选：${target.root}（@deepseek-ai/ 作用域存在但无可解析宿主包——树布局漂移正例，见上方 ⚠ SKIP-UNRESOLVED 汇总）`)
}
push(`退出码：${verdict.exitCode}${verdict.exitCode === 0 ? '（无 FAIL）' : verdict.exitCode === 1 ? '（存在 FAIL）' : '（树不可解析/宿主契约面零断言执行）'}`)

console.log(lines.join('\n'))
process.exit(verdict.exitCode)
