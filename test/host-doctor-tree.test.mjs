/**
 * MAINT-043 单元测试：host-doctor 活树解析 v2（scripts/host-doctor.mjs）。
 *
 * 断言解析序与代际守卫：
 *  · 相对 --tree 归一化为绝对路径（修复探针 #4 createRequire 相对路径崩溃：
 *    "The argument 'filename' must be a file URL object…"）；
 *  · 顺序：--tree > DSH_HOST_TREE（别名 DSH_HOST_PACKAGES）> 桌面 asar
 *    （DSH_ASAR 显式 / 候选自动定位）> 旧缺省 profiles/node_modules；
 *  · DSH_ASAR 指向构造的微型 asar 时优先于旧缺省（提取到缓存树 + 归档内
 *    @deepseek-ai/dsh 元包版本），缺失时 fail-closed 不静默回退；
 *  · 旧缺省层带 STALE 标记与树代际。
 * 全部用临时目录构造，不依赖真实 D:\app\dsh 安装（本机在场的候选通过
 * desktopAsarCandidates 注入隔离，保证测试密闭性）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  resolveTargetTree, locateDesktopAsar, desktopAsarCandidates, treeGeneration,
  ASAR_TREE_PREFIX, defaultAsarCacheDir,
} from '../scripts/host-doctor.mjs'
import { buildMicroAsar, dshMetaPackageJson } from './asar-fixtures.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-tree-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 旧缺省层夹具：<home>/profiles/node_modules/@deepseek-ai/dsh@version 陈旧树。 */
function buildStaleProfilesHome(dir, version = '0.0.1-stale') {
  const home = join(dir, 'home')
  const dshDir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshDir, { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), dshMetaPackageJson(version))
  return home
}

// ── 层①：--tree（绝对路径化——探针 #4 崩溃修复的判别锚）────────────────────
test('(MAINT-043) 相对 --tree 归一化为绝对路径（修复探针 #4 createRequire 崩溃）', async () => {
  const byNodeModules = await resolveTargetTree('rel/trees/node_modules', { env: {} })
  assert.equal(byNodeModules.root, resolve('rel/trees/node_modules'))
  assert.ok(isAbsolute(byNodeModules.root), '探针 #4 createRequire 需要绝对路径')
  assert.equal(byNodeModules.origin, '--tree')
  const byProfilesDir = await resolveTargetTree('rel\\trees\\profiles-dir\\', { env: {} })
  assert.equal(byProfilesDir.root, resolve(join('rel/trees/profiles-dir', 'node_modules')))
  assert.ok(isAbsolute(byProfilesDir.root))
})

// ── 解析顺序 ───────────────────────────────────────────────────────────────
test('(MAINT-043) 顺序①：--tree 优先于 DSH_HOST_TREE / DSH_ASAR / 旧缺省', async () => {
  const result = await resolveTargetTree('cli/node_modules', {
    env: { DSH_HOST_TREE: 'env/tree/node_modules', DSH_ASAR: 'Z:/nonexistent/app.asar' },
    dshHome: 'Z:/nonexistent/home',
  })
  assert.equal(result.origin, '--tree')
  assert.equal(result.root, resolve('cli/node_modules'))
})

test('(MAINT-043) 顺序②：DSH_HOST_TREE 生效且绝对化；DSH_HOST_PACKAGES 别名保留', async () => {
  const viaTree = await resolveTargetTree(undefined, {
    env: { DSH_HOST_TREE: 'env/tree/node_modules' },
    desktopAsarCandidates: [],
    dshHome: 'Z:/nonexistent/home',
  })
  assert.equal(viaTree.origin, 'DSH_HOST_TREE')
  assert.equal(viaTree.root, resolve('env/tree/node_modules'))
  const viaAlias = await resolveTargetTree(undefined, {
    env: { DSH_HOST_PACKAGES: 'env/alias' },
    desktopAsarCandidates: [],
    dshHome: 'Z:/nonexistent/home',
  })
  assert.equal(viaAlias.origin, 'DSH_HOST_PACKAGES(别名)')
  assert.equal(viaAlias.root, resolve(join('env/alias', 'node_modules')))
})

test('(MAINT-043) 顺序③：DSH_ASAR 微型归档提取优先于旧缺省（缓存树 + 归档内代际，不依赖真实安装）', async (t) => {
  const dir = tempDir(t)
  const home = buildStaleProfilesHome(dir)
  const built = buildMicroAsar(join(dir, 'desktop'), [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('9.9.9-test') },
    { path: 'dsh/node_modules/@deepseek-ai/dsh-settings/package.json', content: dshMetaPackageJson('9.9.9-test') },
  ])
  const cacheDir = join(dir, 'cache')
  const env = { DSH_ASAR: built.asarPath }
  const result = await resolveTargetTree(undefined, { env, cacheDir, dshHome: home })
  assert.equal(result.error, null)
  assert.equal(result.root, join(cacheDir, 'dsh', 'node_modules'))
  assert.equal(result.origin, `桌面 asar（${built.asarPath}）`)
  assert.equal(result.stale, null, 'asar 层命中不得落入 STALE 层')
  assert.equal(result.asar.reused, false)
  assert.ok(existsSync(join(result.root, '@deepseek-ai', 'dsh', 'package.json')))
  // 代际守卫：读到的是归档内 dsh 元包版本，而非旧缺省树的 0.0.1-stale
  assert.equal(treeGeneration(result.root), '9.9.9-test')
  assert.equal(ASAR_TREE_PREFIX, 'dsh/node_modules')
  // 二轮：同缓存目录 marker 命中复用
  const again = await resolveTargetTree(undefined, { env, cacheDir, dshHome: home })
  assert.equal(again.asar.reused, true)
  assert.equal(again.root, result.root)
})

test('(MAINT-043) 顺序③：自动定位候选命中微型归档（无 DSH_ASAR 亦走 asar 层）', async (t) => {
  const dir = tempDir(t)
  const home = buildStaleProfilesHome(dir)
  const built = buildMicroAsar(join(dir, 'desktop'), [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('8.8.8-test') },
  ])
  const result = await resolveTargetTree(undefined, {
    env: {},
    desktopAsarCandidates: [built.asarPath],
    cacheDir: join(dir, 'cache'),
    dshHome: home,
  })
  assert.equal(result.error, null)
  assert.ok(result.origin.startsWith('桌面 asar（'))
  assert.ok(result.asar.via.includes('自动定位'))
  assert.equal(treeGeneration(result.root), '8.8.8-test')
})

test('(MAINT-043) 顺序③：DSH_ASAR 指向缺失归档 → fail-closed（不静默回退旧缺省）', async (t) => {
  const dir = tempDir(t)
  const home = buildStaleProfilesHome(dir)
  const missing = join(dir, 'definitely-not-here.asar')
  const result = await resolveTargetTree(undefined, { env: { DSH_ASAR: missing }, dshHome: home })
  assert.equal(result.root, null)
  assert.equal(result.asar, null)
  assert.ok(result.error.includes('DSH_ASAR'), `error 应指明 DSH_ASAR 不可用（实得：${result.error}）`)
  assert.ok(result.error.includes(missing))
})

test('(MAINT-043) 顺序③：DSH_ASAR 归档无 dsh/node_modules 前缀（非 DSH 宿主 asar）→ fail-closed', async (t) => {
  const dir = tempDir(t)
  const home = buildStaleProfilesHome(dir)
  const built = buildMicroAsar(join(dir, 'not-dsh'), [{ path: 'other-app/package.json', content: '{"name":"other"}' }])
  const result = await resolveTargetTree(undefined, {
    env: { DSH_ASAR: built.asarPath },
    cacheDir: join(dir, 'cache'),
    dshHome: home,
  })
  assert.equal(result.root, null)
  assert.ok(result.error.includes(ASAR_TREE_PREFIX), 'error 应指明归档内无宿主树前缀')
})

test('(MAINT-043) 顺序④：无 asar 候选 → 旧缺省 profiles 层 + STALE 标记与树代际', async (t) => {
  const dir = tempDir(t)
  const home = buildStaleProfilesHome(dir, '0.2.1-rc.2-stale')
  const result = await resolveTargetTree(undefined, { env: {}, desktopAsarCandidates: [], dshHome: home })
  assert.equal(result.error, null)
  assert.equal(result.asar, null)
  assert.equal(result.root, join(home, 'profiles', 'node_modules'))
  assert.ok(result.origin.includes('缺省解析'))
  assert.equal(result.stale.generation, '0.2.1-rc.2-stale', 'STALE 层必须输出树代际供运行代比对')
})

// ── locateDesktopAsar / 候选清单 / 代际读取 单元 ───────────────────────────
test('(MAINT-043) locateDesktopAsar：DSH_ASAR 显式优先（resolve 绝对化）；空串=未设置；候选探测与 null', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(join(dir, 'desktop'), [
    { path: 'dsh/node_modules/a.txt', content: 'x' },
  ])
  assert.deepEqual(
    locateDesktopAsar({ DSH_ASAR: 'rel/app.asar' }, []),
    { asarPath: resolve('rel/app.asar'), via: 'DSH_ASAR' },
  )
  const autoHit = locateDesktopAsar({ DSH_ASAR: '' }, [built.asarPath])
  assert.equal(autoHit.via.includes('自动定位'), true)
  assert.equal(autoHit.asarPath, built.asarPath)
  assert.equal(locateDesktopAsar({}, []), null)
})

test('(MAINT-043) desktopAsarCandidates：含本机实测形态 + LOCALAPPDATA per-user 安装根', () => {
  const plain = desktopAsarCandidates({})
  assert.ok(plain.includes('D:\\app\\dsh\\resources\\app.asar'), '本机实测形态（DEC-034）必须在候选清单')
  const withLad = desktopAsarCandidates({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
  assert.ok(withLad.includes(join('C:\\Users\\u\\AppData\\Local', 'Programs', 'dsh', 'resources', 'app.asar')))
})

test('(MAINT-043) defaultAsarCacheDir：仓库 tmp/ 下 doctor-asar-cache；treeGeneration 缺树返回 null', () => {
  assert.equal(defaultAsarCacheDir(), join(repoRoot, 'tmp', 'doctor-asar-cache'))
  assert.equal(treeGeneration(repoRoot), null, '无 @deepseek-ai/dsh 元包的目录 → null（如实展示）')
})
