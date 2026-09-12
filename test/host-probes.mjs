/**
 * host-probes — FEAT-002 判别探针模块（设计 docs/host-compat/design-0.7.6.md §4.1-4.3，
 * DEC-018 ④：doctor 与测试共用本模块，判据零分叉）。
 *
 * 消费方（同一条判据的两个外壳）：
 *  · test/host-face-contract.test.mjs —— node:test + assert/strict 外壳（CI 判别测试）；
 *  · scripts/host-doctor.mjs —— 控制台报告器外壳（npm run host:doctor）。
 * 本模块自身 **禁止** import node:test / 写任何文件——全部探针只读（读文件 /
 * vm 加载 / dynamic import），零写入零网络（doctor 安全约束）。
 *
 * 断言数据源（单一清单，不维护第二份）：lib/host-compat.js 契约常量
 * HOST_EVENTS / HOST_REMOTE_CONTRACT / HOST_PROVENANCE。探针仅携带三类自有
 * 知识（均有出处注释）：① T 级锚串的**形态**（引号/尾随逗号等判别性包装——
 * 值本身来自契约常量）；② 描述符 id 的 controller 前缀映射（真实 bundle 观测，
 * HOST_PROVENANCE C4）；③ 条目 4 超集方法面与条目 10 白名单基线（§4.2 实证清单）。
 *
 * 判别原则（继承 MAINT-025）：断言锚定**真实工件**（vm 加载 / dynamic import /
 * 源码文本），桩仅驱动被测物，禁止桩对桩自证。
 *
 * 双工件源（§4.1）：
 *  工件源① baseline = 仓库 node_modules（devDeps 精确锁版，CI 恒断言 fail-closed，
 *            找不到真实工件即 throw——沿用 host-face-contract 既有语义）；
 *  工件源② live = DSH_HOST_TREE 环境变量（旧名 DSH_HOST_PACKAGES 保留为别名），
 *            在场即对活树执行同一套探针；缺席即整组 SKIP（逐条带原因，不静默）。
 *  T 级断言失败分级（BM-2 / §4.1）：baseline 源 = FAIL（锁版不该漂）；live 源 =
 *  DRIFT（防误报，等待人工语义复核）。B 级失败不分源恒 FAIL（行为断裂是真断裂）。
 *  包不可解析 ≠ 契约 FAIL（BM-3）：该触点 SKIP-UNRESOLVED 归因树布局，不做契约判断。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { HOST_EVENTS, HOST_REMOTE_CONTRACT, HOST_PROVENANCE } from '../lib/host-compat.js'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 工件源模型 ─────────────────────────────────────────────────────────────
/** 工件源①：devDeps 锁版基线（CI fail-closed，任何包缺席即 throw）。 */
export function baselineSource() {
  return { kind: 'baseline', label: 'devDeps 锁版基线', root: join(repoRoot, 'node_modules') }
}

/**
 * 工件源②：活宿主树。DSH_HOST_TREE > DSH_HOST_PACKAGES（旧名别名，FEAT-002 并入）。
 * 接受 profiles 目录或其 node_modules（两者皆可，§4.1）；缺席返回 null（整组 SKIP）。
 */
export function liveSourceFromEnv(env = process.env) {
  const raw = env.DSH_HOST_TREE ?? env.DSH_HOST_PACKAGES
  if (raw === undefined || raw === '') return null
  return {
    kind: 'live', label: `活树 ${raw}`, root: normalizeTreeRoot(raw),
    via: env.DSH_HOST_TREE !== undefined ? 'DSH_HOST_TREE' : 'DSH_HOST_PACKAGES(别名)',
  }
}

/** profiles 目录或 node_modules 目录 → 统一归一到含 @deepseek-ai/ 的 node_modules 根。 */
export function normalizeTreeRoot(path) {
  const raw = String(path).replace(/[\\/]+$/, '')
  const segments = raw.split(/[\\/]+/)
  return segments[segments.length - 1] === 'node_modules' ? raw : join(raw, 'node_modules')
}

/** 仓库 package.json 的 dsh.client.inject 声明（条目 10 判读对象，读文件非硬编码）。 */
export function declaredClientInject(pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))) {
  return [...(pkg.dsh?.client?.inject ?? [])]
}

/** baseline 源的锁版版本（package.json devDependencies；与已安装版本失配即 fail-closed）。 */
export function baselinePinnedVersion(name, pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))) {
  return pkg.devDependencies?.[`@deepseek-ai/${name}`]
}

/**
 * 解析目标树下的 @deepseek-ai/<name>（或顶层 schemastery——条目 7 特例）。
 * 返回 {dir, version} 或 null（不可解析）。neverThrows：BM-3 要求包不可解析走
 * SKIP-UNRESOLVED 而非异常；诊断信息由 collectTreeScanDiagnostics 提供给
 * doctor / fail-closed 报错。
 */
export function resolvePackage(source, name) {
  const dir = name.startsWith('@') ? join(source.root, name) : join(source.root, '@deepseek-ai', name)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return null
  try {
    return { dir, version: JSON.parse(readFileSync(manifest, 'utf8')).version }
  } catch {
    return null
  }
}

/** fail-closed 报错用：目标树已扫描的 @deepseek-ai/* 清单（只读诊断）。 */
export function collectTreeScanDiagnostics(source, name) {
  const scoped = join(source.root, '@deepseek-ai')
  const seen = []
  if (existsSync(scoped)) {
    for (const entry of readdirSync(scoped)) {
      const manifest = join(scoped, entry, 'package.json')
      if (existsSync(manifest)) {
        try { seen.push(`${entry}@${JSON.parse(readFileSync(manifest, 'utf8')).version}`) } catch { seen.push(`${entry}@(manifest 不可解析)`) }
      }
    }
  }
  return { wanted: name, scanned: source.root, present: seen.length, sample: seen.slice(0, 12) }
}

/**
 * baseline 源 fail-closed 解析：包缺席 / 版本与 devDeps 锁版失配即 throw（沿用
 * host-face-contract 既有语义：找不到真实工件绝不降级为桩）。live 源永不 throw
 * ——返回 null 交由调用方标 SKIP-UNRESOLVED。
 */
export function requirePackage(source, name) {
  const resolved = resolvePackage(source, name)
  if (resolved === null) {
    if (source.kind !== 'baseline') return null
    const diag = collectTreeScanDiagnostics(source, name)
    throw new Error(
      `host-probes: 工件源①（${source.label}）未找到 @deepseek-ai/${name} 真实工件（fail-closed，禁止降级为桩）。` +
      `已扫描 ${diag.scanned}（@deepseek-ai/* 共 ${diag.present} 个：${diag.sample.join(', ')}）。` +
      `处置：npm ci --legacy-peer-deps 重装 devDeps（.github/workflows/ci.yml 同款命令）。`,
    )
  }
  if (source.kind === 'baseline') {
    const pinned = baselinePinnedVersion(name)
    if (pinned !== undefined && resolved.version !== pinned) {
      throw new Error(
        `host-probes: 工件源①版本失配——@deepseek-ai/${name} 已安装 ${resolved.version}，devDeps 锁版 ${pinned}。` +
        `锁版基线必须与 package.json 一致（fail-closed）；处置：npm ci --legacy-peer-deps。`,
      )
    }
  }
  return resolved
}

// ── 结果构造 ───────────────────────────────────────────────────────────────
const RESULT_PASS = (evidence) => ({ status: 'PASS', evidence })
const rawFail = (evidence, hint) => ({ status: 'FAIL', evidence, hint })

function makeResult(probe, raw, source) {
  if (raw.status === 'SKIP') {
    return { id: probe.id, touchpoint: probe.touchpoint, level: probe.level, status: 'SKIP', skip: raw.skip, skipReason: raw.skipReason, evidence: raw.evidence ?? '', hint: raw.hint ?? '' }
  }
  let status = raw.status
  // T 级失败分级（BM-2 / §4.1）：baseline=FAIL（锁版不该漂）；live=DRIFT（人工复核）。
  if (raw.status === 'FAIL' && probe.level === 'T' && probe.requiresHostTree && source?.kind === 'live') status = 'DRIFT'
  return { id: probe.id, touchpoint: probe.touchpoint, level: probe.level, status, evidence: raw.evidence, hint: raw.hint ?? '' }
}

// ── 通用只读工具 ───────────────────────────────────────────────────────────
/**
 * 递归收集包 lib/ 下全部 *.js 源码（T 级锚串搜索域；A-4：产物保持可提取文本）。
 * 返回 [{relFile（包内相对路径，/ 分隔）, text}]。
 */
function libSources(pkgDir) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push({ relFile: relative(pkgDir, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') })
    }
  }
  walk(join(pkgDir, 'lib'))
  return out
}

/** 在包 lib 源码中查找锚串，返回首个命中 {relFile, line} 或 null。 */
function findAnchor(sources, anchor) {
  for (const { relFile, text } of sources) {
    const idx = text.indexOf(anchor)
    if (idx !== -1) return { relFile, line: text.slice(0, idx).split('\n').length }
  }
  return null
}

/** 字符串感知括号扫描：自 openIndex（指向 "{"）起匹配闭合位置，未闭合返回 -1。 */
export function matchBrace(source, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// ── 条目 1（S2/S3）：dsh-settings 导出面 + settingsNamespace 跨版本接缝 ────
// 导出面 ⊇ {SettingsConflictError, SettingsProvider, default, redactSecrets}（B 级 import；
// 出处：dsh-settings lib/index.js L610 export 语句，0.1.2-rc.1/0.1.5-rc.2 双源一致）。
// settingsNamespace 双路容忍（§4.2 条目 1）：导出路（须为 function）**或**源码提取
// parseSettingsNamespace 且与 host-compat 本地回退归一化后一致（T 级提取）。
const SETTINGS_EXPORT_FACE = ['SettingsConflictError', 'SettingsProvider', 'default', 'redactSecrets']

/** 归一化：剔除空白/分号/花括号——`if(c){throw x}return v` ≡ `if(c)throw x;return v;`。 */
function normalizeFnBody(body) {
  return body.replace(/[\s;{}]/g, '')
}

/** 从宿主包源码提取 function parseSettingsNamespace 函数体（提取失败 = 路线 B 不可用）。 */
function extractPackageValidator(sources) {
  for (const { relFile, text } of sources) {
    const head = text.indexOf('function parseSettingsNamespace(')
    if (head === -1) continue
    const open = text.indexOf('{', head)
    const close = open === -1 ? -1 : matchBrace(text, open)
    if (close === -1) return { ok: false, why: 'parseSettingsNamespace 函数体未闭合' }
    return { ok: true, body: text.slice(open + 1, close), text, relFile }
  }
  return { ok: false, why: '源码中未找到 function parseSettingsNamespace 声明' }
}

/** 从 lib/host-compat.js 源码提取本地回退校验器函数体（`(value) => {` 全文唯一——已核验）。 */
function extractLocalFallback() {
  const text = readFileSync(join(repoRoot, 'lib', 'host-compat.js'), 'utf8')
  const head = text.indexOf('(value) => {')
  if (head === -1) return { ok: false, why: 'host-compat.js 未找到本地回退箭头函数' }
  const open = text.indexOf('{', head)
  const close = open === -1 ? -1 : matchBrace(text, open)
  if (close === -1) return { ok: false, why: '本地回退函数体未闭合' }
  return { ok: true, body: text.slice(open + 1, close), text }
}

/** 提取 NAMESPACE_PATTERN 正则字面量源文本（两侧正则值比对——名字相同值漂移的补漏）。 */
function extractPatternLiteral(text) {
  const m = text.match(/NAMESPACE_PATTERN\s*=\s*(\/.+?\/[a-z]*)/)
  return m ? m[1] : null
}

async function probeSettingsFace(source) {
  const pkg = requirePackage(source, 'dsh-settings')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'dsh-settings 在目标树不可解析（BM-3：包不可解析 ≠ 契约 FAIL，先确认树布局）' }
  const evidence = [`dsh-settings@${pkg.version}`]
  // B 级：真实 import（peer 链 cordis/dsh-util-values 随工件树自身解析）
  let mod
  try {
    mod = await import(pathToFileURL(join(pkg.dir, 'lib', 'index.js')).href)
  } catch (error) {
    return rawFail(`dsh-settings@${pkg.version} 动态 import 失败：${error?.message ?? error}`, 'S2 宿主包加载即断（MAINT-021 同型致命类）——查 peer 链 cordis/dsh-util-values 在目标树是否可解析')
  }
  const missing = SETTINGS_EXPORT_FACE.filter((name) => mod[name] === undefined)
  if (missing.length > 0) {
    return rawFail(`导出面缺 ${missing.join(', ')}（实得：${Object.keys(mod).sort().join(', ')}）`, 'S2 导出面断裂——命名空间导入虽跨代安全，但导出面收窄预示内部重构；查 HOST_PROVENANCE S2 后人工复核')
  }
  evidence.push(`导出面 ⊇ {${SETTINGS_EXPORT_FACE.join(', ')}}`)
  // 双路容忍——路线 A：包重新导出 settingsNamespace
  if (typeof mod.settingsNamespace === 'function') {
    return RESULT_PASS([...evidence, '接缝走路线 A（包导出 settingsNamespace，typeof function）'].join(' | '))
  }
  // 路线 B：源码提取 + 归一化一致
  const sources = libSources(pkg.dir)
  const host = extractPackageValidator(sources)
  if (!host.ok) {
    return rawFail([...evidence, `路线 B 不可用：${host.why}；且无 settingsNamespace 导出（路线 A 亦缺）`].join(' | '), '双路皆断（§4.2 条目 1 判 FAIL）——查 HOST_PROVENANCE S3 锚（SettingsProvider 入口内部 parseSettingsNamespace），在目标树全文搜索同名函数是否改名/移位')
  }
  const local = extractLocalFallback()
  if (!local.ok) return rawFail([...evidence, `host-compat 侧提取失败：${local.why}`].join(' | '), '本仓库 host-compat.js 回退段形态变更——与宿主无关，先修自有工件')
  const hostBody = normalizeFnBody(host.body)
  const localBody = normalizeFnBody(local.body)
  if (hostBody !== localBody) {
    const firstDiff = [...hostBody].findIndex((ch, i) => ch !== localBody[i])
    const around = (s, i) => s.slice(Math.max(0, i - 10), i + 20)
    return rawFail([...evidence, `路线 B 归一化后不一致（首个分歧@${firstDiff}：宿主 "…${around(hostBody, firstDiff)}…" vs 本地 "…${around(localBody, firstDiff)}…"）`].join(' | '), '宿主命名空间校验语义漂移（静默类）——对照 HOST_PROVENANCE S3 复核正则/报错文案后同步 host-compat.js 本地回退（同一变更单元）')
  }
  const hostPattern = extractPatternLiteral(host.text)
  const localPattern = extractPatternLiteral(local.text)
  if (hostPattern !== localPattern) {
    return rawFail([...evidence, `NAMESPACE_PATTERN 漂移：宿主 ${hostPattern} vs 本地 ${localPattern}`].join(' | '), '命名空间品牌正则变更——复核后同步 host-compat.js（同一变更单元）')
  }
  return RESULT_PASS([...evidence, `接缝走路线 B（${host.relFile} parseSettingsNamespace 提取归一化一致，pattern ${hostPattern}）`].join(' | '))
}

// ── 条目 2（S6）：事件名 ×4（T 级锚串，值取 HOST_EVENTS）────────────────────
// 锚串形态自带判别性包装：agent/request 用「尾引号+逗号」与 agent/request-error 区分
// （后者是前者的超串——裸 includes 会在错误事件行假命中）。锚点出处 HOST_PROVENANCE S6 各行。
const EVENT_ANCHORS = [
  { key: 'settingsUpdated', pkg: 'dsh-settings', wrap: (v) => `"${v}"` },
  { key: 'agentRequest', pkg: 'dsh-agent-loop', wrap: (v) => `"${v}",` },
  { key: 'agentRequestError', pkg: 'dsh-agent-loop', wrap: (v) => `"${v}"` },
  { key: 'llmStream', pkg: 'dsh-llm', wrap: (v) => `"${v}"` },
]
// 锚点包的**去重**集合（4 锚 → 3 包）：全不可解析判定必须以包数为基。MAINT-031 项①
// 修前比的是 EVENT_ANCHORS.length（4 锚）vs unresolvedPkgs（Set 去重 ≤3 包）——恒不可达，
// 整树不可解析时落入 partial 分支文案「可解析包的锚点全部命中」误导排查方向。本集合
// 由 EVENT_ANCHORS 派生（单一事实源）：改锚表即同步，不会二次漂移。
const EVENT_ANCHOR_PKGS = [...new Set(EVENT_ANCHORS.map((anchor) => anchor.pkg))]

function probeEventNames(source) {
  const cache = new Map()
  const rows = []
  const unresolvedPkgs = new Set()
  let failed = false
  for (const { key, pkg, wrap } of EVENT_ANCHORS) {
    const value = HOST_EVENTS[key]
    const anchor = wrap(value)
    if (!cache.has(pkg)) {
      const resolved = requirePackage(source, pkg)
      cache.set(pkg, resolved === null ? null : { resolved, sources: libSources(resolved.dir) })
      if (resolved === null) unresolvedPkgs.add(pkg)
    }
    const entry = cache.get(pkg)
    if (entry === null) {
      rows.push(`${key}("${value}") SKIP-UNRESOLVED(${pkg} 不可解析)`)
      continue
    }
    const hit = findAnchor(entry.sources, anchor)
    if (hit === null) {
      failed = true
      rows.push(`${key}("${value}") ✗未命中（${entry.resolved.version}）`)
    } else {
      rows.push(`${key}("${value}") → ${entry.resolved.version} ${hit.relFile}:L${hit.line}`)
    }
  }
  // 全不可解析 = 可解析包集合为空（unresolvedPkgs ⊆ EVENT_ANCHOR_PKGS，两者等势即无包可解析）。
  // MAINT-031 项①：判定基必须是去重包数（EVENT_ANCHOR_PKGS），不得用锚数——否则本分支恒不可达，
  // 整树不可解析时错报「可解析包的锚点全部命中」。
  if (unresolvedPkgs.size === EVENT_ANCHOR_PKGS.length) {
    return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: `${EVENT_ANCHOR_PKGS.join('/')} 均在目标树不可解析（BM-3：先确认树布局，不做契约判断）`, evidence: rows.join(' ; ') }
  }
  if (failed) {
    return rawFail(rows.join(' ; '), '事件名漂移 = 钩子永不触发的静默失效（三次事故同型）——查 HOST_PROVENANCE S6 各行 anchor，在目标树全文搜索旧事件名变体，必要时查宿主 changelog')
  }
  if (unresolvedPkgs.size > 0) {
    return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: `${[...unresolvedPkgs].join('/')} 在目标树不可解析——可解析包的锚点全部命中，但整体判定不完整（BM-3 树布局归因）`, evidence: rows.join(' ; ') }
  }
  return RESULT_PASS(rows.join(' ; '))
}

// ── 条目 3（S10）：webServer.register 路由形状（T 级锚串）───────────────────
// 锚串出处：dsh-host-webserver lib/index.js L177-180（0.1.2-rc.1/0.1.5-rc.2 双源逐字节一致）：
//   register(route) { const table = route.kind === "exact" ? this.exact : this.prefixes;
//   if (table.has(route.path)) throw …; table.set(route.path, route); … }
const WEBSERVER_ANCHORS = ['route.kind === "exact"', 'table.set(route.path, route)', 'table.has(route.path)']

function probeWebServerRegister(source) {
  const pkg = requirePackage(source, 'dsh-host-webserver')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'dsh-host-webserver 在目标树不可解析（BM-3 树布局归因）' }
  const sources = libSources(pkg.dir)
  const rows = []
  let failed = false
  for (const anchor of WEBSERVER_ANCHORS) {
    const hit = findAnchor(sources, anchor)
    if (hit === null) { failed = true; rows.push(`✗"${anchor}"`) } else rows.push(`"${anchor}" → ${hit.relFile}:L${hit.line}`)
  }
  if (failed) {
    return rawFail(`dsh-host-webserver@${pkg.version} ${rows.join(' ; ')}`, '路由注册面漂移——查 HOST_PROVENANCE S10（register({kind:"exact",path,handler})）；注册失败虽降级（lib/index.js L1065-1069），形状断裂 = 统计/探测端点静默消失')
  }
  return RESULT_PASS(`dsh-host-webserver@${pkg.version} ${rows.join(' ; ')}`)
}

// ── 条目 4（C4）：api-remotes RPC 集 + 元数表（B 级 vm 真实工件判别）─────────
// 描述符 id 的 controller 前缀（真实 bundle 观测，HOST_PROVENANCE C4）。
const CONTROLLER_OF = { settings: '@deepseek-ai/dsh-api-settings-controller', session: '@deepseek-ai/dsh-api-session-controller' }
// settings 域超集方法面（§4.2 条目 4 实证清单：本插件消费 describe/update/mutate +
// 同域共存 replace/openSettingsDocument/openAgentPresetDirectory/canOpenAgentPresetDirectory
// ——超集断言防宿主收敛方法集而适配层尚存消费的静默断裂）。
const SETTINGS_DOMAIN_SUPERSET = ['describe', 'update', 'mutate', 'replace', 'openSettingsDocument', 'openAgentPresetDirectory', 'canOpenAgentPresetDirectory']

export function descriptorIdOf(methodKey) {
  const [domain, method] = methodKey.split('.')
  return `${CONTROLLER_OF[domain]}#${domain}/${method}`
}

/** vm 加载真实 dsh-api-remotes bundle → 真实 apply() → 捕获全部 contribution（MAINT-025 Half A 泛化）。 */
export async function loadApiRemotesContributions(pkgDir) {
  const clientFile = join(pkgDir, 'lib', 'client.js')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(def) { loaded = def } } } }
  vm.runInNewContext(readFileSync(clientFile, 'utf8'), sandbox, { filename: clientFile })
  if (!loaded || loaded.id !== '@deepseek-ai/dsh-api-remotes') throw new Error(`api-remotes bundle 未能经 __ModuleLoader__ 契约捕获（C1 形态断裂）：${clientFile}`)
  const exports = loaded.factory(() => { throw new Error('host api-remotes bundle required unexpected module') })
  const contributions = []
  const disposer = await exports.apply({
    remote: { $mount: async (contribution) => { contributions.push(contribution); return async () => {} } },
  })
  return { contributions, disposer }
}

export function descriptorOf(contributions, id) {
  for (const contribution of contributions) {
    for (const descriptor of contribution.descriptors ?? []) {
      if (descriptor.id === id) return descriptor
    }
  }
  return null
}

/**
 * 元数表判据（判据唯一实现点——测试与 doctor 共用）：真实描述符参数表 ===
 * HOST_REMOTE_CONTRACT.methods（参数名逐位 + arity + 第三参 acceptsUndefined +
 * cancellation===undefined——四要素双源实证 0.1.2-rc.1/0.1.5-rc.2 一致）。
 * 返回 {ok, rows}；rows 人机共读。
 */
export function checkArityTable(contributions) {
  const rows = []
  for (const [key, spec] of Object.entries(HOST_REMOTE_CONTRACT.methods)) {
    const id = descriptorIdOf(key)
    const descriptor = descriptorOf(contributions, id)
    if (descriptor === null) {
      rows.push(`${key} ✗描述符缺席（${id}）`)
      return { ok: false, rows }
    }
    // 跨 realm：descriptor 产自 vm realm——参数名经 Array.from 拷回本地再比（先例注释）。
    const names = Array.from(descriptor.parameters.map((p) => p.name))
    const matchName = names.length === spec.params.length && names.every((n, i) => n === spec.params[i])
    const third = spec.thirdParamAcceptsUndefined === true
      ? descriptor.parameters[spec.params.length - 1]?.acceptsUndefined === true
      : true
    if (!matchName || descriptor.parameters.length !== spec.arity || !third || descriptor.cancellation !== undefined) {
      rows.push(`${key} ✗实得 arity=${descriptor.parameters.length} params=[${names.join(',')}] 第三参 acceptsUndefined=${String(descriptor.parameters[spec.params.length - 1]?.acceptsUndefined)} cancellation=${String(descriptor.cancellation)}（期望 ${spec.arity} 参 [${spec.params.join(',')}]）`)
      return { ok: false, rows }
    }
    rows.push(`${key}(${spec.params.join(',')}) ✓`)
  }
  return { ok: true, rows }
}

async function probeApiRemotesRpc(source) {
  const pkg = requirePackage(source, 'dsh-api-remotes')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'dsh-api-remotes 在目标树不可解析（BM-3 树布局归因）' }
  let loaded
  try {
    loaded = await loadApiRemotesContributions(pkg.dir)
  } catch (error) {
    return rawFail(`dsh-api-remotes@${pkg.version} bundle 加载/apply 失败：${error?.message ?? error}`, 'C1/C4 形态断裂——查 HOST_PROVENANCE C1（makeRequire/loader 契约）与 C4（描述符面）')
  }
  const { contributions, disposer } = loaded
  try {
    const settingsIds = new Set()
    let modelCatalog = null
    for (const c of contributions) {
      for (const d of c.descriptors ?? []) {
        if (d.id?.startsWith(`${CONTROLLER_OF.settings}#settings/`)) settingsIds.add(d.id.slice(`${CONTROLLER_OF.settings}#settings/`.length))
        if (d.id === descriptorIdOf('session.modelCatalog')) modelCatalog = d
      }
    }
    const missingSuperset = SETTINGS_DOMAIN_SUPERSET.filter((m) => !settingsIds.has(m))
    if (missingSuperset.length > 0) {
      return rawFail(`dsh-api-remotes@${pkg.version} settings 域方法集缺 {${missingSuperset.join(', ')}}（实得 {${[...settingsIds].sort().join(', ')}}；contributions=${contributions.length}）`, 'C4 方法集收敛——查 HOST_PROVENANCE C4 描述符锚，复核适配层消费面是否需跟随收敛')
    }
    if (modelCatalog === null) {
      return rawFail(`dsh-api-remotes@${pkg.version} session.modelCatalog 描述符缺席（contributions=${contributions.length}）`, 'C4 modelCatalog 缺席 = 模型级默认卡数据面断——查 HOST_PROVENANCE C4')
    }
    const arity = checkArityTable(contributions)
    if (!arity.ok) {
      return rawFail(`dsh-api-remotes@${pkg.version} 元数表失配：${arity.rows.join(' ; ')}（contributions=${contributions.length}）`, 'MAINT-025 同型：宿主网关在 RPC 前严格元数守卫——元数断裂 = 「保存失败」确定性 throw。复核 HOST_REMOTE_CONTRACT.methods 与 client.js 镜像段（同一变更单元）')
    }
    // contributions 计数为证据非断言（0.1.2-rc.1=12 / 0.1.5-rc.2=15——宿主演进正常增量；
    // 判别锚是方法集+元数表。地板 12 = RCA §3 Half A 实测基线，防 contribution 大面积丢失）。
    if (contributions.length < 12) {
      return rawFail(`contributions=${contributions.length} < 12（RCA §3 Half A 实测基线地板）`, 'apply() 挂载面大面积丢失——查 bundle 形态（HOST_PROVENANCE C1）')
    }
    return RESULT_PASS(`dsh-api-remotes@${pkg.version} contributions=${contributions.length}；settings 域 ⊇ {${SETTINGS_DOMAIN_SUPERSET.join(',')}}；modelCatalog ✓；元数表 ${arity.rows.join(' ')}`)
  } finally {
    await disposer()
  }
}

// ── 条目 5（S9）：dsh-llm effort 校验结构（T 级锚串）────────────────────────
// 锚串出处：dsh-llm lib/index.js resolveCallWithInfo 校验段（0.1.2-rc.1 L1561-1590 /
// 0.1.5-rc.2 L2111-2127——临时声明机制的存在前提，MAINT-014/017 事故关联触点）。
const LLM_EFFORT_ANCHORS = ['resolveCallWithInfo(config, info) {', 'UNSUPPORTED_REASONING_EFFORT', 'reasoning.efforts.some(']

function probeLlmEffortValidation(source) {
  const pkg = requirePackage(source, 'dsh-llm')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'dsh-llm 在目标树不可解析（BM-3 树布局归因）' }
  const sources = libSources(pkg.dir)
  const rows = []
  let failed = false
  for (const anchor of LLM_EFFORT_ANCHORS) {
    const hit = findAnchor(sources, anchor)
    if (hit === null) { failed = true; rows.push(`✗"${anchor}"`) } else rows.push(`"${anchor}" → ${hit.relFile}:L${hit.line}`)
  }
  if (failed) return rawFail(`dsh-llm@${pkg.version} ${rows.join(' ; ')}`, 'S9 校验结构漂移 = 临时声明探测机制失效（表现为探测全 blocked，半显式）——查 HOST_PROVENANCE S9（resolveCallWithInfo effort 校验段）')
  return RESULT_PASS(`dsh-llm@${pkg.version} ${rows.join(' ; ')}`)
}

// ── 条目 6（S8）：agent/request payload reasoningEffort 字段（T 级锚串）─────
// 锚串出处：dsh-agent-loop lib/index.js payload schema（0.1.2-rc.1 L1056 / 0.1.5-rc.2
// L1497 reasoningEffort: z.string().min(1)；注入点 0.1.5-rc.2 L1136-1140）。
// S8 按 D6 显式豁免出契约常量表——锚串属探针自有知识，出处走 HOST_PROVENANCE S8 行。
const AGENT_EFFORT_ANCHORS = ['reasoningEffort: z.string().min(1)', ': { reasoningEffort },']

function probeAgentRequestEffortField(source) {
  const pkg = requirePackage(source, 'dsh-agent-loop')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'dsh-agent-loop 在目标树不可解析（BM-3 树布局归因）' }
  const sources = libSources(pkg.dir)
  const rows = []
  let failed = false
  for (const anchor of AGENT_EFFORT_ANCHORS) {
    const hit = findAnchor(sources, anchor)
    if (hit === null) { failed = true; rows.push(`✗"${anchor}"`) } else rows.push(`"${anchor}" → ${hit.relFile}:L${hit.line}`)
  }
  if (failed) return rawFail(`dsh-agent-loop@${pkg.version} ${rows.join(' ; ')}`, 'S8 字段漂移 = 注入被宿主忽略而统计照常（假象健康，静默类）——查 HOST_PROVENANCE S8（payload schema reasoningEffort 键）')
  return RESULT_PASS(`dsh-agent-loop@${pkg.version} ${rows.join(' ; ')}`)
}

// ── 条目 7（S1）：schemastery 使用面（B 级 import 探测）─────────────────────
const SCHEMASMASTERY_FACE = ['object', 'union', 'dict', 'boolean', 'const', 'string', 'array']

async function probeSchemastery(source) {
  const pkg = requirePackage(source, 'schemastery')
  if (pkg === null) return { status: 'SKIP', skip: 'UNRESOLVED', skipReason: 'schemastery 在目标树不可解析（BM-3 树布局归因）' }
  let mod
  try {
    mod = await import(pathToFileURL(join(pkg.dir, 'lib', 'index.mjs')).href)
  } catch (error) {
    return rawFail(`schemastery@${pkg.version} 动态 import 失败：${error?.message ?? error}`, 'S1 致命类：默认导出缺席 = 模块加载期 SyntaxError = 整机启动失败（MAINT-021 同型）')
  }
  const z = mod.default
  if (typeof z !== 'function') return rawFail(`schemastery@${pkg.version} default export typeof=${typeof z}（须为 function）`, 'S1 默认导出面断裂——MAINT-021 同型致命')
  const missing = SCHEMASMASTERY_FACE.filter((k) => typeof z[k] !== 'function')
  if (missing.length > 0) return rawFail(`schemastery@${pkg.version} 使用面缺 {${missing.join(', ')}}`, 'S1 使用面（z.object/union/…）收窄——D3：schemastery 直连不入契约表，本探针为其唯一守护；查 lib/index.js 30+ 消费点受影响面')
  return RESULT_PASS(`schemastery@${pkg.version} default=function；{${SCHEMASMASTERY_FACE.join(',')}} 全为 function`)
}

// ── 条目 8（C1）：客户端 bundle 形态自检（自有工件，T 级）──────────────────
export function clientRequireSet(sourceText) {
  return [...new Set([...sourceText.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]))].sort()
}

function probeClientBundleForm() {
  const source = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
  const required = clientRequireSet(source)
  if (required.length !== 1 || required[0] !== 'react') {
    return rawFail(`require 调用集合 = [${required.join(', ')}]（期望恰 ['react']）`, 'C1 形态破裂：makeRequire 解析域仅平台 seed 词（dsh-client-modules L300-310）——require 未知名 = materialize 期 throw = 页面死')
  }
  if (!source.includes('SINGLE-SOURCE-MIRROR')) {
    return rawFail('client.js 缺 SINGLE-SOURCE-MIRROR 标记段', 'BM-4 机器可检标记锚被删——镜像段纪律（与 host-compat.js 同 commit）失去锚定点')
  }
  return RESULT_PASS('require 集 === ["react"]；SINGLE-SOURCE-MIRROR 标记在位')
}

// ── 条目 9（C2/C4）：镜像单源一致性（自有工件 ×2，B 级）────────────────────
/**
 * 经 __ModuleLoader__ 契约加载真实 client.js 并捕获工厂（C1 隐式守护——形态破裂即抛）。
 */
export function loadClientFactory() {
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(def) { loaded = def } } } }
  vm.runInNewContext(readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
  if (loaded === null || loaded.id !== 'dsh-reasoning-level') throw new Error('client.js 未能经 __ModuleLoader__ 契约捕获（C1 形态断裂）')
  return loaded
}

/**
 * 从 client.js 工厂源码提取镜像段对象字面量并在 vm 求值（提取器唯一实现点——
 * host-compat-single-source 测试与本探针共用，判据零分叉）。提取源是
 * loaded.factory.toString()——镜像段若被挪出工厂体即找不到声明而红。
 */
export function extractMirrorLiteral(factorySource) {
  const markerIndex = factorySource.indexOf('SINGLE-SOURCE-MIRROR')
  if (markerIndex === -1) throw new Error('工厂内必须存在 SINGLE-SOURCE-MIRROR 标记段（BM-4 机器可检标记锚）')
  const declIndex = factorySource.indexOf('const HOST_REMOTE_CONTRACT', markerIndex)
  if (declIndex === -1) throw new Error('标记段之后必须存在 const HOST_REMOTE_CONTRACT 声明（镜像段形态：标记 + 数据字面量）')
  const openIndex = factorySource.indexOf('{', declIndex)
  const closeIndex = matchBrace(factorySource, openIndex)
  if (closeIndex === -1) throw new Error('HOST_REMOTE_CONTRACT 对象字面量未闭合（字符串感知括号扫描到工厂源码尾）')
  const literal = factorySource.slice(openIndex, closeIndex + 1)
  return vm.runInNewContext('(' + literal + ')', {}, { filename: 'client-mirror.extract' })
}

/**
 * 镜像判等（判据唯一实现点）：两侧 JSON 归一化（跨 realm 原型域规避——先例：
 * client-host-face-compat mutate ops 断言注释）后 **deepStrictEqual**（R-2 收紧：
 * 防跨型巧合如 arity 1 vs '1'）。HOST_REMOTE_CONTRACT 纯数据，归一化无损。
 * 失配时逐字段定位首个分歧（人机共读 WHY）。
 */
export function mirrorMatches(mirror, contract) {
  const left = JSON.parse(JSON.stringify(mirror))
  const right = JSON.parse(JSON.stringify(contract))
  try {
    assert.deepStrictEqual(left, right)
    return { ok: true, why: `逐字段一致（域：{${Object.keys(right).sort().join(', ')}}）` }
  } catch {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      const l = JSON.stringify(left[key])
      const r = JSON.stringify(right[key])
      if (l !== r || !(key in left) || !(key in right)) {
        return { ok: false, why: `字段 "${key}" 失配：client 镜像 ${l ?? '(缺席)'} vs host-compat ${r ?? '(缺席)'}` }
      }
    }
    return { ok: false, why: 'deepStrictEqual 失败但逐字段 stringify 未定位到分歧（嵌套差异）' }
  }
}

function probeMirrorSingleSource() {
  try {
    const loaded = loadClientFactory()
    const mirror = extractMirrorLiteral(loaded.factory.toString())
    const verdict = mirrorMatches(mirror, HOST_REMOTE_CONTRACT)
    if (!verdict.ok) {
      return rawFail(verdict.why, 'BM-4 单源锚定断裂：dsh 升级适配必须 host-compat.js + client.js 镜像段同一变更单元同步修改（设计 §3.3 / 编程要求 4）')
    }
    return RESULT_PASS(verdict.why)
  } catch (error) {
    return rawFail(`镜像段提取失败：${error?.message ?? error}`, 'client.js 工厂内镜像段形态破裂（标记/声明/闭合三锚之一）——BM-4')
  }
}

// ── 条目 10（C6）：dsh.client.inject 声明存在性（T 级）─────────────────────
// 白名单基线（清理后三名，MAINT-029 commit 910baed）：A-2 实现期验证结论——
// dsh-client-ui-settings / dsh-client-locale 未入 devDeps 锁（本任务授权面仅
// agent-loop/llm/host-webserver 三包），基线按 §4.2 † 预写降级为白名单比对。
const INJECT_WHITELIST_BASELINE = ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-api-remotes']
// T-F2 归因分叉依据：电池其余宿主树探针依赖的 co-tree 包清单——普遍不可解析
// （全部缺席）⇒ 目标树是残树/布局漂移，而非死声明（BM-3 同款宽容归因）。
const CO_TREE_HOST_PACKAGES = ['dsh-settings', 'dsh-agent-loop', 'dsh-llm', 'dsh-host-webserver', 'dsh-api-remotes']

function probeClientInjectDeclaration(source) {
  const declared = declaredClientInject()
  if (declared.length === 0) return rawFail('package.json dsh.client.inject 声明缺席', 'C6：runner 激活门控失去等待面——查 package.json dsh.client.inject')
  if (source.kind === 'baseline') {
    const actual = [...declared].sort()
    const expected = [...INJECT_WHITELIST_BASELINE].sort()
    if (actual.join('|') !== expected.join('|')) {
      return rawFail(`白名单比对失配：声明 [${actual.join(', ')}] vs 清理后三名基线 [${expected.join(', ')}]`, 'C6 死声明再引入（MAINT-029 同型）或名单漂移——arriveGraphRow 对未知名静默跳过（L265-268），宿主未来收紧严格校验即激活失败；同步更新白名单与 HOST_PROVENANCE C6')
    }
    return RESULT_PASS(`白名单比对 === 清理后三名基线 [${expected.join(', ')}]（ui-settings/locale 未锁 devDep，按 §4.2 † 降级路径）`)
  }
  const rows = []
  let failed = false
  for (const declaredName of declared) {
    const resolved = resolvePackage(source, declaredName)
    if (resolved === null) { failed = true; rows.push(`${declaredName} ✗目标树不可解析`) } else rows.push(`${declaredName}@${resolved.version} ✓`)
  }
  if (failed) {
    // T-F2：同树其他宿主包普遍不可解析（co-tree 全缺席）时，「声明的包不可解析」
    // 是树布局问题——按 UNRESOLVED 归因，不恒归 DRIFT「死声明」误导排查方向。
    const coTreeResolved = CO_TREE_HOST_PACKAGES.filter((name) => resolvePackage(source, name) !== null).length
    if (coTreeResolved === 0) {
      return {
        status: 'SKIP', skip: 'UNRESOLVED',
        skipReason: `声明的包在目标树不可解析，且同树其他宿主包（${CO_TREE_HOST_PACKAGES.join('/')}）亦全部不可解析——树布局问题（BM-3/T-F2），不做死声明判断`,
        evidence: rows.join(' ; '),
        hint: '先确认树布局（--tree 指向含 @deepseek-ai/ 的 node_modules）——布局修复后死声明判定才有意义',
      }
    }
    return rawFail(rows.join(' ; '), 'C6：声明的包在活树不存在 = 死声明（今日静默跳过，宿主收紧即致命）——查 HOST_PROVENANCE C6 与 package.json dsh.client.inject')
  }
  return RESULT_PASS(`逐声明名在活树可解析：${rows.join(' ; ')}`)
}

// ── 条目 11（C3）：适配层 fail-loud 语义回归（自有工件，B 级驱动）───────────
// 判据唯一实现点：命名空间剥离 → Promise 拒绝携带结构化原因（可归属本插件 +
// 指明宿主命名空间缺失），禁止裸 "Cannot read properties of undefined"。
// client-host-face-compat 的页面级 fail-loud 用例消费同一判据（FACE_ERROR_PATTERNS）。
export const FACE_ERROR_PATTERNS = [/dsh-reasoning-level/, /remote\.settings|宿主|命名空间|不兼容/]

export function isStructuredFaceError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return FACE_ERROR_PATTERNS.every((pattern) => pattern.test(message))
}

async function probeFailLoud() {
  try {
    const loaded = loadClientFactory()
    const react = { createElement: (tag, props) => ({ tag, props: props ?? {} }) }
    const client = loaded.factory((name) => {
      if (name === 'react') return react
      throw new Error('client required unexpected module: ' + name)
    })
    const registered = []
    client.apply({
      // remote.* 全剥离（模拟宿主版本不兼容：命名空间未挂载）——桩仅驱动被测物，
      // 被测物（适配层 fail-loud）是真实 client.js 工件。
      get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
      slots: {
        inject: (_slot, provider) => provider(),
        register: (meta, render) => { registered.push({ meta, render }); return () => {} },
      },
    })
    if (registered.length !== 1) return rawFail(`apply 注册 settings.section 数=${registered.length}（期望 1）`, 'C3：注册面断裂——适配层惰性解析前提失守')
    const api = registered[0].render({}).props.api
    if (!api?.settings) return rawFail('渲染 props 未携带适配层 api', 'C3：适配层出口断裂')
    const error = await api.settings.describe({}).then(() => null, (e) => e)
    if (error === null) return rawFail('命名空间缺失时 describe 未拒绝（假绿不可能——本探针驱动真实 client.js 工件）', 'C3：fail-loud 语义回归——剥离 remote.* 后必须结构化拒绝（MAINT-022 P8）')
    if (!isStructuredFaceError(error)) {
      return rawFail(`拒绝错误非结构化：${String(error?.message ?? error).slice(0, 160)}`, 'C3：须可归属本插件并指明宿主命名空间缺失（禁止裸 TypeError 击穿面板）')
    }
    return RESULT_PASS(`remote.* 剥离 → describe 结构化拒绝：${String(error.message).slice(0, 80)}…`)
  } catch (error) {
    return rawFail(`fail-loud 探针驱动失败：${error?.message ?? error}`, 'C3 驱动面自身断裂——查 client.js 加载契约')
  }
}

// ── 探针注册表（§4.2 十一条——顺序即条目号）────────────────────────────────
// requiresHostTree：条目 8/9/11 为自有工件探针（无源依赖，测试与 doctor 恒跑）。
export const PROBES = [
  { id: 1, touchpoint: 'S2/S3 dsh-settings 导出面 + settingsNamespace 接缝（双路容忍）', level: 'B+T', requiresHostTree: true, run: probeSettingsFace },
  { id: 2, touchpoint: 'S6 事件名 ×4（settings/updated · agent/request · agent/request-error · llm/stream）', level: 'T', requiresHostTree: true, run: probeEventNames },
  { id: 3, touchpoint: 'S10 webServer.register({kind:"exact",path,handler})', level: 'T', requiresHostTree: true, run: probeWebServerRegister },
  { id: 4, touchpoint: 'C4 api-remotes RPC 集 + 元数表 === HOST_REMOTE_CONTRACT.methods', level: 'B', requiresHostTree: true, run: probeApiRemotesRpc },
  { id: 5, touchpoint: 'S9 dsh-llm resolveCallWithInfo effort 校验结构', level: 'T', requiresHostTree: true, run: probeLlmEffortValidation },
  { id: 6, touchpoint: 'S8 agent/request payload reasoningEffort 字段', level: 'T', requiresHostTree: true, run: probeAgentRequestEffortField },
  { id: 7, touchpoint: 'S1 schemastery 默认导出 + 使用面', level: 'B', requiresHostTree: true, run: probeSchemastery },
  { id: 8, touchpoint: 'C1 客户端 bundle 形态（require 集 === [react] + 镜像标记段）', level: 'T', requiresHostTree: false, run: probeClientBundleForm },
  { id: 9, touchpoint: 'C2/C4 镜像单源一致性（client 镜像段 === HOST_REMOTE_CONTRACT）', level: 'B', requiresHostTree: false, run: probeMirrorSingleSource },
  { id: 10, touchpoint: 'C6 dsh.client.inject 声明存在性（白名单基线/活树解析）', level: 'T', requiresHostTree: true, run: probeClientInjectDeclaration },
  { id: 11, touchpoint: 'C3 适配层 fail-loud（命名空间剥离 → 结构化错误）', level: 'B', requiresHostTree: false, run: probeFailLoud },
]

/**
 * 执行单条探针（含分级包装）。live 源缺席时 requiresHostTree 条目返回显式 SKIP
 * （带原因——不静默不假绿）；baseline 源缺席/失配由 requirePackage fail-closed throw。
 */
export async function runEntry(probe, source) {
  if (probe.requiresHostTree && source === null) {
    return {
      id: probe.id, touchpoint: probe.touchpoint, level: probe.level, status: 'SKIP', skip: 'LIVE-TREE-ABSENT',
      skipReason: 'DSH_HOST_TREE 未设置——活树源缺席，本条目按设计显式 skip（工件源① devDeps 基线在 CI 恒断言）',
      evidence: '', hint: '设 DSH_HOST_TREE=<profiles 目录或其 node_modules> 即对活树执行本探针',
    }
  }
  try {
    const raw = await probe.run(source)
    return makeResult(probe, raw, source)
  } catch (error) {
    // baseline fail-closed（解析层 throw）直接透传——CI 必须红且带扫描路径；
    // live 源的意外异常按 FAIL 归因（探针自身缺陷也是可发现面）。
    if (source?.kind === 'baseline') throw error
    return { id: probe.id, touchpoint: probe.touchpoint, level: probe.level, status: 'FAIL', evidence: `探针异常：${error?.message ?? error}`, hint: '探针执行期异常——先复核探针模块与目标树布局' }
  }
}

/** 执行整组探针（doctor / 测试侧聚合入口）。 */
export async function runBattery(source) {
  const results = []
  for (const probe of PROBES) results.push(await runEntry(probe, source))
  return results
}

/**
 * doctor 退出码判定（§4.3，MAINT-030 F-1/T-F1 收口——判据唯一实现点，doctor
 * 与判别测试共用，零分叉）：executed 统计域 = requiresHostTree 条目。自有工件
 * 探针（条目 8/9/11）零环境依赖恒可执行，不计入该守卫——否则「宿主树断言
 * 零执行」分支永远不可达（死守卫，FEAT-002-R0 impl F-1 / test T-F1）。宿主
 * 契约面零断言执行（如空作用域树全部 SKIP-UNRESOLVED）本身就是 exit 2 级
 * 异常（BM-3：doctor 永不输出「全绿但宿主契约面零判定」）；FAIL 恒优先。
 */
export function doctorExit(results) {
  const hostTreeIds = new Set(PROBES.filter((p) => p.requiresHostTree).map((p) => p.id))
  const hasFail = results.some((r) => r.status === 'FAIL')
  const hostExecuted = results.filter((r) => hostTreeIds.has(r.id)
    && (r.status === 'PASS' || r.status === 'FAIL' || r.status === 'DRIFT')).length
  const exitCode = hasFail ? 1 : hostExecuted === 0 ? 2 : 0
  return { exitCode, hasFail, hostExecuted }
}

// ── doctor 辅助：宿主版本清单 + 漂移定位建议（§4.3）────────────────────────
/** 目标树内全部 @deepseek-ai/* 的 name@version（只读；部分可解析也照常输出）。 */
export function hostVersionManifest(source) {
  const scoped = join(source.root, '@deepseek-ai')
  const manifest = []
  if (existsSync(scoped)) {
    for (const entry of readdirSync(scoped)) {
      const pkgJson = join(scoped, entry, 'package.json')
      if (existsSync(pkgJson)) {
        try { manifest.push({ name: `@deepseek-ai/${entry}`, version: JSON.parse(readFileSync(pkgJson, 'utf8')).version }) } catch { manifest.push({ name: `@deepseek-ai/${entry}`, version: '(manifest 不可解析)' }) }
      }
    }
  }
  return manifest.sort((a, b) => a.name.localeCompare(b.name))
}

/** 从触点描述提取 S/C 编号（如 "S2/S3 dsh-settings…" → ['S2','S3']）并查 HOST_PROVENANCE 行。 */
export function provenanceFor(touchpoint) {
  const ids = [...touchpoint.matchAll(/\b([SC]\d+)\b/g)].map((m) => m[1])
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  return HOST_PROVENANCE.filter((row) => unique.some((id) => row.touchpoint.startsWith(id)))
}
