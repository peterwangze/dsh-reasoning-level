/**
 * FEAT-008 判别测试：加载器接缝档案化（S13）三面看护。
 *
 *  ① 探针 #13（host-probes）fixture 树判别——不依赖真实 DSH 安装：
 *     · 三包在场 + 锚串为 0.2.2-rc.5 宿主源码**逐字摘录**（本文件硬编码真实
 *       源文本）→ PASS——HOST_LOADER_SEAM 锚串若与真实宿主源漂移，此用例即红
 *       （锚串判别力锚点，非循环自证）；
 *     · 锚串缺失（宿主改解析机制模拟：installAnchor 构造改名/作用域字面变体/
 *       PluginPackages 接线消失/裸包名委托改写）→ live=DRIFT / baseline=FAIL
 *       （T 级分级，与探针 #6 负相同型）；
 *     · 三包全缺席（树上仅 dsh-settings 等非接缝包）→ SKIP-UNRESOLVED + INFO
 *       说明（接缝包不在 devDeps 锁版，仅桌面 asar 树/完整安装树在场）；
 *     · 部分在场（仅 dsh-app-boot——compat-022rc5 镜像树真实形态：app-boot
 *       传递在场、desktop-host/dsh 不在）→ 在场包锚串照常断言 PASS + 缺席包
 *       INFO 行。
 *  ② 单源：HOST_LOADER_SEAM.peers 键集 === package.json peerDependencies 键集
 *     （观测名单不与清单漂移；先例 = 镜像单源 deep-equal / declaredClientInject
 *     读 manifest）。
 *  ③ observePeerResolution fail-soft：不可解析名 → {resolved: null, reason}
 *     （逐名 try/catch 吸收，绝不抛出）；真实 4 peer（本仓 devDeps 在场，CI
 *     npm ci 保证）→ {resolved: <file URL>, version: <string>}。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROBES, runEntry } from './host-probes.mjs'
import { HOST_LOADER_SEAM, observePeerResolution } from '../lib/host-compat.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry13 = PROBES.find((p) => p.id === 13)

// ── fixture：0.2.2-rc.5 宿主源码逐字摘录（真实锚文本，硬编码防循环自证）──────
// 出处见 HOST_PROVENANCE S13：desktop-host lib/index.js L350-354 /
// dsh lib/profile-boot-QhDEDXsF.js L242-245+L313-317（放入独立 chunk 文件名，
// 证明锚定不依赖 chunk 哈希后缀）/ dsh-app-boot lib/index.js L1550/L1574/L1580/L4901。
const DESKTOP_HOST_LIB = [
  '\tconst runtimeDir = process.argv[2];',
  '\tconst projectDir = process.argv[3];',
  '\tprocess.env.DSH_PRIMARY_RUNTIME = process.argv[4] || join(runtimeDir, "..", "runtime", "primary-runtime");',
  '\tconst installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");',
  '\tconst profile = loadProfileDirectory("dsh", projectDir, installAnchor);',
].join('\n')
const DSH_PROFILE_BOOT_LIB = [
  'import { PluginPackages, boot, createRuntimeResolution } from "@deepseek-ai/dsh-app-boot";',
  '\treturn {',
  '\t\tprofile,',
  '\t\tresolution: await createRuntimeResolution({',
  '\t\t\tinstallAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,',
  '\t\t\tprofile',
  '\t\t}),',
  '\t};',
  '\t\tconst ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => {',
  '\t\t\tawait hostCtx.plugin(PluginPackages, { resolution: composed.resolution });',
  '\t\t});',
].join('\n')
const APP_BOOT_LIB = [
  'async function createRuntimeResolution(options) {',
  '\tconst { installAnchor, profile, home = resolveDshHome() } = options;',
  '\tconst { packageNames, packageDirs, declarers, versions } = collectInstallationScopePackages(installAnchor, new Set());',
  '\t\t\t\tscope: "installation"',
  '\t\t\t})), ...[...profilePackages].map(([name, packageDir]) => Object.freeze({',
  '\t\t\t\tname,',
  '\t\t\t\tpackageDir,',
  '\t\t\t\tversion: profileVersions.get(name),',
  '\t\t\t\tdeclarer: profileDeclarers.get(name),',
  '\t\t\t\tscope: "profile"',
  '\tctx.loader.builtins.include = bareModuleBaseUrl === void 0 ? Include : class HostResolvedRootInclude extends Include {',
  '\t\t\treturn internal.import(specifier, bareModuleBaseUrl, {});',
  '\t};',
].join('\n')

// 锚串缺失变体（宿主改解析机制的四种模拟：锚构造改名 / 作用域字面变体 /
// 接线消失 / 裸包名委托改写——六锚全灭，负相最强形态）。
const DESKTOP_HOST_LIB_DRIFT = DESKTOP_HOST_LIB.replace(
  'join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json")',
  'join(baseDir, "packages", "dsh-root.json")',
)
const DSH_PROFILE_BOOT_LIB_DRIFT = DSH_PROFILE_BOOT_LIB.replace(
  'hostCtx.plugin(PluginPackages, { resolution: composed.resolution });',
  'hostCtx.plugin(PackageRegistry, { resolutionTable: composed.resolution });',
)
const APP_BOOT_LIB_DRIFT = APP_BOOT_LIB
  .replace('async function createRuntimeResolution', 'async function buildRuntimePackageTable')
  .replace('scope: "installation"', 'scope: "host-install"')
  .replace('scope: "profile"', 'scope: "user-profile"')
  .replace('internal.import(specifier, bareModuleBaseUrl, {})', 'internal.require(specifier, hostBase, {})')

/** 构造 fixture 树（os.tmpdir() 隔离）：seam 包按需在场，另放一个非接缝包证明归因。 */
function forgeSeamTree(dir, { desktopHost = true, dshMeta = true, appBoot = true, drift = false } = {}) {
  const root = join(dir, 'node_modules')
  mkdirSync(join(root, '@deepseek-ai'), { recursive: true })
  const forge = (name, libFiles) => {
    const pkgDir = join(root, '@deepseek-ai', name)
    for (const [file, text] of Object.entries(libFiles)) {
      mkdirSync(join(pkgDir, dirname(file)), { recursive: true })
      writeFileSync(join(pkgDir, file), text)
    }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.2-rc.5-fixture', type: 'module' }, null, 2))
  }
  if (desktopHost) forge('dsh-desktop-host', { 'lib/index.js': drift ? DESKTOP_HOST_LIB_DRIFT : DESKTOP_HOST_LIB })
  if (dshMeta) forge('dsh', { 'lib/profile-boot-F1XTURE0.js': drift ? DSH_PROFILE_BOOT_LIB_DRIFT : DSH_PROFILE_BOOT_LIB })
  if (appBoot) forge('dsh-app-boot', { 'lib/index.js': drift ? APP_BOOT_LIB_DRIFT : APP_BOOT_LIB })
  // 非接缝宿主包（在场以证明 SKIP 归因到接缝三包而非整树布局）
  forge('dsh-settings', { 'lib/index.js': 'export class SettingsForms {}\n' })
  return { kind: 'live', label: `fixture 树（${dir}）`, root }
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-seam-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── ① 探针 #13 fixture 判别 ─────────────────────────────────────────────────
test('(feat008/seam-1) 接缝三包在场 + 锚串为 0.2.2-rc.5 真实源逐字摘录 → PASS（锚点命中含包版本与文件行）', async (t) => {
  assert.ok(entry13 !== undefined, '探针 #13 必须在注册表')
  const source = forgeSeamTree(tempDir(t))
  const r = await runEntry(entry13, source)
  assert.equal(r.status, 'PASS', `三包在场且锚串真实 → 必须 PASS：\n${r.evidence}`)
  // 六锚逐一命中（三包 × 各自锚数）；dsh 的锚在独立 chunk 文件名中命中 = 不依赖 chunk 哈希
  for (const name of ['dsh-desktop-host', 'dsh', 'dsh-app-boot']) {
    assert.match(r.evidence, new RegExp(`${name}@0\\.2\\.2-rc\\.5-fixture ".*" → lib/.*:L\\d+`), `${name} 锚点必须命中并携带文件:行`)
  }
  assert.match(r.evidence, /profile-boot-F1XTURE0\.js/, 'dsh 锚点必须在非 index 的 chunk 文件中命中（锚定不依赖文件名）')
})

test('(feat008/seam-2) 锚串缺失（宿主改解析机制模拟）→ live=DRIFT / baseline=FAIL（T 级分级）+ 证据指明缺失锚', async (t) => {
  const dir = tempDir(t)
  const live = forgeSeamTree(dir, { drift: true })
  const rLive = await runEntry(entry13, live)
  assert.equal(rLive.status, 'DRIFT', `live 源锚串缺失必须 DRIFT（实得 ${rLive.status}）：\n${rLive.evidence}`)
  assert.match(rLive.evidence, /dsh-desktop-host@.*✗/, '证据必须指明 desktop-host 缺失锚')
  assert.match(rLive.hint, /S13/, '提示必须指向 HOST_PROVENANCE S13 台账')

  // baseline 源同树：T 级失败分级 = FAIL（探针对接缝包不用 requirePackage，不触发
  // 版本锁 fail-closed throw——接缝包不在 devDeps 锁版，缺席/在场均不 throw）
  const baseline = forgeSeamTree(mkdtempSync(join(tmpdir(), 'dsh-loader-seam-base-')), { drift: true })
  baseline.kind = 'baseline'
  t.after(() => rmSync(baseline.root, { recursive: true, force: true }))
  const rBaseline = await runEntry(entry13, baseline)
  assert.equal(rBaseline.status, 'FAIL', `baseline 源锚串缺失必须 FAIL（实得 ${rBaseline.status}）`)
})

test('(feat008/seam-3) 三包全缺席（仅非接缝包在场）→ SKIP-UNRESOLVED + INFO 说明不在 devDeps 锁版', async (t) => {
  const source = forgeSeamTree(tempDir(t), { desktopHost: false, dshMeta: false, appBoot: false })
  const r = await runEntry(entry13, source)
  assert.equal(r.status, 'SKIP', `三包全缺席必须 SKIP（实得 ${r.status}）`)
  assert.equal(r.skip, 'UNRESOLVED')
  assert.match(r.skipReason, /不在 devDeps 锁版/, `skip 必须说明接缝包不在锁版（实得：${r.skipReason}）`)
  assert.match(r.skipReason, /dsh-desktop-host\/dsh\/dsh-app-boot/, 'skip 必须点名接缝三包')
  assert.match(r.hint ?? '', /asar|完整树/, 'hint 必须给出如何让接缝包可断言')
})

test('(feat008/seam-4) 部分在场（仅 dsh-app-boot——镜像树真实形态）→ 在场锚串照常断言 PASS + 缺席包 INFO 行', async (t) => {
  const source = forgeSeamTree(tempDir(t), { desktopHost: false, dshMeta: false })
  const r = await runEntry(entry13, source)
  assert.equal(r.status, 'PASS', `部分在场时在场包锚串必须照常断言（实得 ${r.status}）：\n${r.evidence}`)
  assert.match(r.evidence, /dsh-app-boot@0\.2\.2-rc\.5-fixture "async function createRuntimeResolution" → lib\/index\.js:L\d+/, '在场包锚点命中')
  assert.match(r.evidence, /dsh-desktop-host 目标树不可解析（INFO/, '缺席包必须记 INFO 行（非 FAIL）')
  assert.match(r.evidence, /\bdsh 目标树不可解析（INFO/, '缺席包必须记 INFO 行（非 FAIL）')
})

// FEAT-008 rework：基线电池的 #13 断言按树形状条件化（全缺席=SKIP / 任一在场
// =PASS）——本用例用 fixture 构造基线源的在场形态（不依赖真实镜像树），钉死
// **baseline 分级下的 PASS 路径**：接缝包传递在场（rc.5 镜像闭包：app-boot 经
// dsh-agent-default-model→dsh-config-editor 传递在场，npm ls 实证）时探针不得
// 误报 FAIL/SKIP；在场包锚串漂移在 baseline 分级下 = FAIL（seam-2 已证）——
// 判别力两态齐全。
test('(feat008/seam-5) 基线源在场路径（fixture）：全场 → PASS；部分在场（镜像闭包形态）→ PASS + 缺席 INFO（baseline 分级不误报）', async (t) => {
  const full = forgeSeamTree(tempDir(t))
  full.kind = 'baseline'
  full.label = 'fixture 基线源（三包全场）'
  const rFull = await runEntry(entry13, full)
  assert.equal(rFull.status, 'PASS', `基线源三包在场且锚串真实必须 PASS（实得 ${rFull.status}）：\n${rFull.evidence}`)

  const partial = forgeSeamTree(tempDir(t), { desktopHost: false, dshMeta: false })
  partial.kind = 'baseline'
  partial.label = 'fixture 基线源（app-boot 传递在场——镜像闭包形态）'
  const rPartial = await runEntry(entry13, partial)
  assert.equal(rPartial.status, 'PASS', `基线源部分在场必须 PASS（在场包照常断言；实得 ${rPartial.status}）：\n${rPartial.evidence}`)
  assert.match(rPartial.evidence, /dsh-app-boot@0\.2\.2-rc\.5-fixture "scope: "installation"" → lib\/index\.js:L\d+/, '在场包锚点命中（baseline 分级）')
  assert.match(rPartial.evidence, /\bdsh 目标树不可解析（INFO/, '缺席包记 INFO 行（baseline 分级同样不误报 FAIL）')
})

// ── ② 单源：观测名单 === package.json peerDependencies 键集 ──────────────────
test('(feat008/single-source) HOST_LOADER_SEAM.peers 键集 === package.json peerDependencies 键集', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.deepEqual(
    [...HOST_LOADER_SEAM.peers].sort(),
    Object.keys(pkg.peerDependencies ?? {}).sort(),
    '观测名单必须与 peer 声明清单一致（名单漂移 = 观测面缺口或误报）',
  )
})

// ── ③ observePeerResolution fail-soft ───────────────────────────────────────
test('(feat008/observe-1) 不可解析名 → {resolved: null, reason}（逐名吸收，绝不抛出）', () => {
  const observed = observePeerResolution(['@deepseek-ai/definitely-not-a-peer'])
  const entry = observed['@deepseek-ai/definitely-not-a-peer']
  assert.ok(entry !== undefined, '名单内条目必须在场')
  assert.equal(entry.resolved, null, '解析失败必须记录 resolved: null')
  assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `失败必须带 reason（实得 ${JSON.stringify(entry)}）`)
  // fail-soft 铁律：任何输入不抛出（含 null/undefined 名单项的防御由 for..of 天然
  // 逐名隔离——单名异常不殃及后续条目）
  const mixed = observePeerResolution(['@deepseek-ai/definitely-not-a-peer', '@deepseek-ai/cordis'])
  assert.notEqual(mixed['@deepseek-ai/cordis'].resolved, null, '前名失败不得殃及后续条目')
})

test('(feat008/observe-2) 真实 4 peer（devDeps 在场环境）→ {resolved: <URL>, version: <string>} 形状', () => {
  const observed = observePeerResolution()
  assert.deepEqual(Object.keys(observed).sort(), [...HOST_LOADER_SEAM.peers].sort(), '缺省名单 = HOST_LOADER_SEAM.peers')
  for (const [name, entry] of Object.entries(observed)) {
    assert.notEqual(entry.resolved, null, `${name} 在 devDeps 在场环境必须解析成功（实得 ${JSON.stringify(entry)}）`)
    assert.match(entry.resolved, /^file:/, `${name} resolved 必须是 file URL`)
    assert.ok(typeof entry.version === 'string' && entry.version.length > 0, `${name} version 必须从 package.json 读到字符串`)
  }
  // 版本与 devDeps 锁版一致（解析事实的可信度锚——解析到了错误副本时第一时间可见）
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (observed[name] !== undefined) assert.equal(observed[name].version, version, `${name} 解析版本必须 === devDeps 锁版`)
  }
})
