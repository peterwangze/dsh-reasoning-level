/**
 * host-doctor — DSH 宿主兼容面诊断（FEAT-002，设计 §4.3 / DEC-018 ④；
 * 活树源 v2 = MAINT-043）。
 *
 * 用途：dsh 升级后第一步——一条命令输出逐触点 PASS/FAIL/DRIFT/SKIP + 宿主版本
 * 清单 + 漂移定位建议。与判别测试共用同一探针模块 test/host-probes.mjs
 * （测试绿 ⟺ doctor 绿，判据零分叉）。探针全程只读零网络；MAINT-043 起
 * 唯一写入面 = asar 层提取缓存 tmp/doctor-asar-cache/（marker + 提取物，
 * tmp/ 不入 git）。
 *
 *   node scripts/host-doctor.mjs [--tree <宿主树>]
 *   npm run host:doctor [--tree <宿主树>]
 *
 * 目标树解析顺序（MAINT-043 v2）：
 *   ① --tree（相对/绝对皆可——normalizeTreeRoot 一律归一为绝对路径，探针 #4
 *      createRequire 需绝对路径，相对路径曾致崩溃）；
 *   ② DSH_HOST_TREE（旧名 DSH_HOST_PACKAGES 为别名）；
 *   ③ 桌面 asar 自动定位：DSH_ASAR 显式指定 > 固定候选清单（本机形态
 *      D:\app\dsh\resources\app.asar 等，见 desktopAsarCandidates）→ 定位成功
 *      则提取归档内 dsh/node_modules 到缓存树（ensureAsarTreeCache：marker
 *      记录源路径+size+mtime，脏了才重提取）并以缓存树为目标树；
 *   ④ 旧缺省 $DSH_HOME||~/.dsh 下 profiles/node_modules——**醒目 STALE 警示**：
 *      桌面版宿主包已内化 asar，该树可能非运行代（陈旧幻影树曾产出 12/12
 *      假 PASS——fail-open，MAINT-043 根因），输出其代际版本供比对。
 * ③层显式指定（DSH_ASAR）不可用 = fail-closed exit 2（不静默回退到可能陈旧
 * 的缺省树）；候选全部缺席则静默跳过该层落到④。
 *
 * 退出码：0 = 无 FAIL（DRIFT 允许 0 但醒目输出）；1 = 存在 FAIL；
 * 2 = 目标树不可解析（列出解析链与已扫描候选）、活树源解析中止（asar 层
 * fail-closed）或宿主契约面零断言执行（BM-3；判定与测试同源 doctorExit）。
 *
 * @module dsh-reasoning-level/scripts/host-doctor
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHomeSafe } from '../lib/host-compat.js'
import { ensureAsarTreeCache } from './extract-asar.mjs'
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

const USAGE = '用法：node scripts/host-doctor.mjs [--tree <profiles 目录或其 node_modules>]（环境变量：DSH_HOST_TREE / DSH_HOST_PACKAGES 别名 / DSH_ASAR=<桌面版 app.asar 路径>）'

// ── 桌面 asar 层（MAINT-043 活树源 v2）─────────────────────────────────────
/** asar 内宿主包树前缀（DSH 桌面版 0.2.2-rc.1 起全量内化；实测 18896 文件）。 */
export const ASAR_TREE_PREFIX = 'dsh/node_modules'

/** doctor 提取缓存目录（marker 脏检查；tmp/ 不入 git）。 */
export function defaultAsarCacheDir() {
  return join(scriptRoot, 'tmp', 'doctor-asar-cache')
}

/**
 * 桌面版 app.asar 候选清单：本机实测形态（DEC-034：D:\app\dsh\resources\app.asar，
 * 209MB）+ Electron 常规 per-user 安装根。全部缺席 = 静默跳过 asar 层。
 * 非常规安装位置用 DSH_ASAR 显式指定。
 */
export function desktopAsarCandidates(env = process.env) {
  const candidates = ['D:\\app\\dsh\\resources\\app.asar']
  if (env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== '') {
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'dsh', 'resources', 'app.asar'))
  }
  return candidates
}

/**
 * 桌面版 app.asar 定位：DSH_ASAR 显式优先（此处不校验存在性——缺失由
 * resolveTargetTree fail-closed 报告）；否则探测候选清单首个在场者；
 * 全部缺席返回 null。
 */
export function locateDesktopAsar(env = process.env, candidates = desktopAsarCandidates(env)) {
  const explicit = env.DSH_ASAR
  if (explicit !== undefined && explicit !== '') return { asarPath: resolve(explicit), via: 'DSH_ASAR' }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { asarPath: resolve(candidate), via: `自动定位（候选 ${candidate}）` }
  }
  return null
}

/** 目标树代际 = 树内 @deepseek-ai/dsh 元包版本（缺/不可解析返回 null——如实展示）。 */
export function treeGeneration(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

// ── 目标树解析（MAINT-043 v2 顺序）─────────────────────────────────────────
// MAINT-030/F-2：scanned 解析链（原始输入→归一化）在**全部**分支透传。
// options（测试注入位）：env（环境变量快照）/ cacheDir（asar 提取缓存）/
// desktopAsarCandidates（自动定位候选）/ dshHome（缺省 DSH home 覆盖——
// 生产路径仍单源走 resolveDshHomeSafe，见 lib/host-compat.js F-3）。
export async function resolveTargetTree(cliTree, options = {}) {
  const env = options.env ?? process.env
  const cacheDir = options.cacheDir ?? defaultAsarCacheDir()
  const candidates = options.desktopAsarCandidates ?? desktopAsarCandidates(env)
  const scanned = []
  if (cliTree !== undefined) {
    const root = normalizeTreeRoot(cliTree)
    scanned.push(`原始输入 --tree ${cliTree} → 归一化 ${root}`)
    return { root, origin: '--tree', scanned, asar: null, stale: null, error: null }
  }
  if (env.DSH_HOST_TREE !== undefined && env.DSH_HOST_TREE !== '') {
    const root = normalizeTreeRoot(env.DSH_HOST_TREE)
    scanned.push(`原始输入 DSH_HOST_TREE=${env.DSH_HOST_TREE} → 归一化 ${root}`)
    return { root, origin: 'DSH_HOST_TREE', scanned, asar: null, stale: null, error: null }
  }
  const envSource = liveSourceFromEnv(env)
  if (envSource !== null && envSource.via.includes('别名')) {
    scanned.push(`原始输入 DSH_HOST_PACKAGES=${env.DSH_HOST_PACKAGES}（别名）→ 归一化 ${envSource.root}`)
    return { root: envSource.root, origin: 'DSH_HOST_PACKAGES(别名)', scanned, asar: null, stale: null, error: null }
  }
  // ── 层③：桌面 asar 自动定位 + 提取（MAINT-043）──────────────────────────
  const located = locateDesktopAsar(env, candidates)
  if (located !== null) {
    scanned.push(`桌面 asar 定位：${located.asarPath}（来源：${located.via}）`)
    if (!existsSync(located.asarPath)) {
      // 显式 DSH_ASAR 不可用 = fail-closed：静默落到可能陈旧的缺省树正是本轮
      // 要修复的 fail-open 缺陷（12/12 假 PASS）。
      const error = `DSH_ASAR 指向的归档不存在：${located.asarPath}（显式指定必须可用——不静默回退到可能陈旧的旧缺省树）`
      return { root: null, origin: 'DSH_ASAR（不可用）', scanned, asar: null, stale: null, error }
    }
    try {
      const cached = await ensureAsarTreeCache({ asarPath: located.asarPath, cacheDir, prefix: ASAR_TREE_PREFIX })
      const stats = cached.stats ?? {}
      if ((stats.underPrefix ?? 0) === 0) {
        const error = `归档 ${located.asarPath} 内不存在前缀 ${ASAR_TREE_PREFIX}（非 DSH 宿主 asar？）——${located.via === 'DSH_ASAR' ? '检查 DSH_ASAR 指向' : '自动定位候选误命中：用 DSH_ASAR 显式指定正确归档，或 --tree 覆盖'}`
        return { root: null, origin: `${located.via}（前缀缺失）`, scanned, asar: null, stale: null, error }
      }
      scanned.push(`提取 ${ASAR_TREE_PREFIX} → 缓存 ${cacheDir}${cached.reused ? '（marker 命中，复用未重提取）' : `（重提取：extracted=${stats.extracted ?? '?'} unpackedCopied=${stats.unpackedCopied ?? '?'}）`}`)
      return {
        root: cached.root,
        origin: `桌面 asar（${located.asarPath}）`,
        scanned,
        asar: { asarPath: located.asarPath, via: located.via, cacheDir, reused: cached.reused, stats },
        stale: null,
        error: null,
      }
    } catch (error) {
      // 归档在场但不可用（格式坏/unpacked 缺失/读取失败）= fail-closed exit 2：
      // 继续落到旧缺省树会复现假 PASS fail-open（MAINT-043 根因）。
      const message = error?.code === 'ASAR_UNPACKED_MISSING' || error?.code === 'ASAR_FORMAT'
        ? `归档 ${located.asarPath} 不可用——${error.message}`
        : `归档 ${located.asarPath} 读取/提取失败——${error?.message ?? error}`
      return { root: null, origin: `${located.via}（不可用）`, scanned, asar: null, stale: null, error: message }
    }
  }
  // ── 层④：旧缺省 profiles/node_modules（醒目 STALE 警示）───────────────────
  const home = options.dshHome ?? resolveDshHomeSafe()
  if (home === undefined) {
    scanned.push('原始输入 resolveDshHomeSafe() = undefined（DSH_HOME 未设置且 homedir 不可用）')
    return { root: null, origin: '缺省解析失败', scanned, asar: null, stale: null, error: null }
  }
  const root = join(home, 'profiles', 'node_modules')
  scanned.push(`原始输入 resolveDshHomeSafe() = ${home} → 归一化 ${root}`)
  return { root, origin: `缺省解析（${home} 下 profiles/node_modules）`, scanned, asar: null, stale: { generation: treeGeneration(root) }, error: null }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (args.errors.length > 0) {
    console.error(`host-doctor: 参数错误——${args.errors.join('；')}\n${USAGE}`)
    process.exit(2)
  }

  const target = await resolveTargetTree(args.tree)
  const lines = []
  const push = (s = '') => lines.push(s)

  push('dsh-reasoning-level host-doctor（FEAT-002 宿主兼容面诊断，设计 §4.3；活树源 v2 MAINT-043）')
  const generation = target.root === null ? null : treeGeneration(target.root)
  push(`目标树：${target.root ?? '（不可解析）'}（来源：${target.origin}${generation !== null ? `；树代际：@deepseek-ai/dsh@${generation}` : ''}）`)
  if (target.asar !== null) {
    const s = target.asar.stats ?? {}
    push(`asar 层：源归档 ${target.asar.asarPath} → 提取缓存 ${target.asar.cacheDir}${target.asar.reused ? '（marker 命中复用，未重提取）' : `（本轮重提取：extracted=${s.extracted ?? '?'} 文件 + unpackedCopied=${s.unpackedCopied ?? '?'}）`}；脏检查 marker = 源路径 + size + mtime`)
  }
  if (target.stale !== null) {
    push('')
    push('⚠⚠ STALE 警示——目标树命中旧缺省 profiles/node_modules 层：')
    push('  DSH 桌面版（0.2.2-rc.1 起）宿主包已全量内化 app.asar 归档，文件系统上不再存在 node 可直读的宿主包树；')
    push('  该 profiles 树可能不是当前运行代（陈旧幻影树会产出假 PASS——fail-open，MAINT-043 根因）。')
    push(`  本树代际：@deepseek-ai/dsh@${target.stale.generation ?? '（不可解析）'}——若与运行实例代际不符，以下全部结论不可信。`)
    push('  处置：桌面安装的 app.asar 存在时 doctor 自动定位提取（本轮未命中——检查安装路径）；或 DSH_ASAR=<归档路径> 显式指定；或 --tree 指向可信树。')
  }
  if (target.error !== null) {
    push('')
    push(`✗ 活树源解析中止——${target.error}`)
    push('  解析链（原始输入→归一化）：')
    for (const s of target.scanned) push(`  - ${s}`)
    console.log(lines.join('\n'))
    process.exit(2)
  }

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
    push('  桌面版布局为 app.asar 内化（doctor 自动定位提取）；亦可用 --tree 显式指向含 @deepseek-ai/ 的 node_modules 目录。')
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

  // ── 逐触点表（§4.2 十二条，探针与判别测试共用）──────────────────────────────
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
  push(`退出码：${verdict.exitCode}${verdict.exitCode === 0 ? '（无 FAIL）' : verdict.exitCode === 1 ? '（存在 FAIL）' : '（树不可解析/活树源解析中止/宿主契约面零断言执行）'}`)

  console.log(lines.join('\n'))
  process.exit(verdict.exitCode)
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) await main()
