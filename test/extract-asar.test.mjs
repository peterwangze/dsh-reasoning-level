/**
 * MAINT-043 单元测试：extract-asar 读取器（scripts/extract-asar.mjs）。
 *
 * 测试内手工构造微型 asar Buffer（test/asar-fixtures.mjs——与生产读取器独立
 * 实现，判别原则：构造 ≠ 解析的两份拷贝），断言：
 *  · 头解析（pickle 前缀/JSON 头/blob 基址）与构造一致；
 *  · 提取（packed 字节级一致/嵌套目录/prefix 过滤/unpacked 回退拷贝/缺失计数）；
 *  · 防御校验（AsarFormatError/code=ASAR_FORMAT：载荷≠4、头载荷≠H−4、文件
 *    过短、JSON 超出头载荷、blob 基址越界）；
 *  · 提取缓存 ensureAsarTreeCache（marker 落盘/命中复用/源归档变脏重提取/
 *    unpacked 缺失拒绝产出半残树）。
 * 全部临时目录构造，不依赖真实 D:\app\dsh 安装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AsarFormatError, readAsarHeader, walkAsarFiles, extractAsar, probeAsar,
  ensureAsarTreeCache, ASAR_CACHE_MARKER,
} from '../scripts/extract-asar.mjs'
import { buildMicroAsar, patchU32le, dshMetaPackageJson } from './asar-fixtures.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'extract-asar-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── 头解析 ─────────────────────────────────────────────────────────────────
test('(MAINT-043) readAsarHeader：pickle 前缀 + JSON 头 + blob 基址与构造一致', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('1.0.0-test') },
    { path: 'readme.txt', content: 'hello asar' },
  ])
  const info = await readAsarHeader(built.asarPath)
  assert.deepEqual(info.header, built.header)
  assert.equal(info.dataBase, built.dataBase)
  assert.equal(info.jsonSize, Buffer.byteLength(JSON.stringify(built.header)))
  assert.equal(info.size, readFileSync(built.asarPath).length)
  assert.ok(Number.isFinite(info.mtimeMs))
})

test('(MAINT-043) walkAsarFiles：深度遍历仅产文件条目（/ 分隔相对路径）', (t) => {
  const built = buildMicroAsar(tempDir(t), [
    { path: 'a/b/c.txt', content: 'x' },
    { path: 'top.txt', content: 'y' },
  ])
  const files = walkAsarFiles(built.header)
  assert.deepEqual(files.map((f) => f.relPath).sort(), ['a/b/c.txt', 'top.txt'])
})

// ── 提取 ───────────────────────────────────────────────────────────────────
test('(MAINT-043) extractAsar：packed 条目字节级一致 + 嵌套目录 + prefix 过滤', async (t) => {
  const dir = tempDir(t)
  const binary = Buffer.from([0, 255, 10, 13, 10, 0, 1])
  const built = buildMicroAsar(dir, [
    { path: 'readme.txt', content: 'outside prefix' },
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('2.0.0-test') },
    { path: 'dsh/node_modules/.bin/blob.dat', content: binary },
  ])
  const outDir = join(dir, 'out')
  const stats = await extractAsar({ archive: built.asarPath, outDir, prefix: 'dsh/node_modules' })
  assert.equal(stats.underPrefix, 2)
  assert.equal(stats.extracted, 2)
  assert.equal(stats.unpackedCopied, 0)
  assert.equal(readFileSync(join(outDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), dshMetaPackageJson('2.0.0-test'))
  assert.deepEqual(readFileSync(join(outDir, 'dsh', 'node_modules', '.bin', 'blob.dat')), binary)
  assert.equal(existsSync(join(outDir, 'readme.txt')), false, 'prefix 外条目不得提取')
  assert.equal(stats.totalFiles, 3)
})

test('(MAINT-043) extractAsar：unpacked 条目从 app.asar.unpacked 拷贝回填', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/native/exe.bin', content: 'UNPACKED-BYTES', unpacked: true },
    { path: 'dsh/node_modules/packed.txt', content: 'packed' },
  ])
  const outDir = join(dir, 'out')
  const stats = await extractAsar({ archive: built.asarPath, outDir, prefix: 'dsh/node_modules' })
  assert.equal(stats.unpackedCopied, 1)
  assert.equal(stats.unpackedMissing, 0)
  assert.equal(readFileSync(join(outDir, 'dsh', 'node_modules', 'native', 'exe.bin'), 'utf8'), 'UNPACKED-BYTES')
})

test('(MAINT-043) extractAsar：unpacked 实体缺失 → 计数 + missingPaths（不抛，由调用方裁决）', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/gone.bin', content: 'X', unpacked: true },
  ])
  // 删除 unpacked 实体 → 归档声明与外部目录不配套
  rmSync(built.unpackedRoot, { recursive: true, force: true })
  const outDir = join(dir, 'out')
  const stats = await extractAsar({ archive: built.asarPath, outDir, prefix: 'dsh/node_modules' })
  assert.equal(stats.unpackedMissing, 1)
  assert.deepEqual(stats.missingPaths, ['dsh/node_modules/gone.bin'])
  assert.equal(existsSync(join(outDir, 'dsh', 'node_modules', 'gone.bin')), false)
})

// ── 防御校验（负相——结构化 AsarFormatError，绝不静默产出错树）──────────────
test('(MAINT-043) 防御校验：尺寸 pickle 载荷 ≠ 4 → AsarFormatError(ASAR_FORMAT)', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [{ path: 'a.txt', content: 'x' }])
  const corrupt = patchU32le(built.asarPath, join(dir, 'corrupt-size.asar'), 0, 5)
  await assert.rejects(
    () => readAsarHeader(corrupt),
    (error) => error instanceof AsarFormatError && error.code === 'ASAR_FORMAT' && error.message.includes('4'),
  )
})

test('(MAINT-043) 防御校验：头 pickle 载荷 ≠ H−4 → AsarFormatError', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [{ path: 'a.txt', content: 'x' }])
  const headerPickleSize = readFileSync(built.asarPath).readUInt32LE(4)
  const corrupt = patchU32le(built.asarPath, join(dir, 'corrupt-payload.asar'), 8, headerPickleSize - 3)
  await assert.rejects(
    () => readAsarHeader(corrupt),
    (error) => error instanceof AsarFormatError && error.code === 'ASAR_FORMAT' && error.message.includes('≠'),
  )
})

test('(MAINT-043) 防御校验：文件过短（< 20 字节）→ AsarFormatError', async (t) => {
  const dir = tempDir(t)
  const short = join(dir, 'tiny.asar')
  writeFileSync(short, Buffer.alloc(10))
  await assert.rejects(() => readAsarHeader(short), (error) => error instanceof AsarFormatError)
})

test('(MAINT-043) 防御校验：JSON 长度超出头载荷 → AsarFormatError', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [{ path: 'a.txt', content: 'x' }])
  const headerPayloadSize = readFileSync(built.asarPath).readUInt32LE(8)
  const corrupt = patchU32le(built.asarPath, join(dir, 'corrupt-jsonlen.asar'), 12, headerPayloadSize)
  await assert.rejects(
    () => readAsarHeader(corrupt),
    (error) => error instanceof AsarFormatError && error.code === 'ASAR_FORMAT' && error.message.includes('JSON'),
  )
})

test('(MAINT-043) 防御校验：blob 基址越界（H 虚增）→ AsarFormatError', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [{ path: 'a.txt', content: 'x' }])
  const buf = readFileSync(built.asarPath)
  const corruptPath = join(dir, 'corrupt-database.asar')
  patchU32le(built.asarPath, corruptPath, 4, buf.readUInt32LE(4) + 4096)
  patchU32le(corruptPath, corruptPath, 8, buf.readUInt32LE(4) + 4092) // 保持 H−4 一致，仅让基址越界
  await assert.rejects(
    () => readAsarHeader(corruptPath),
    (error) => error instanceof AsarFormatError && error.code === 'ASAR_FORMAT' && error.message.includes('基址'),
  )
})

test('(MAINT-043) probeAsar：只读统计（totalFiles/unpacked/underPrefix/dataBase）', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'outside.txt', content: 'x' },
    { path: 'dsh/node_modules/a.js', content: 'a' },
    { path: 'dsh/node_modules/b.bin', content: 'b', unpacked: true },
  ])
  const stats = await probeAsar(built.asarPath, 'dsh/node_modules')
  assert.equal(stats.totalFiles, 3)
  assert.equal(stats.unpacked, 1)
  assert.equal(stats.underPrefix, 2)
  assert.equal(stats.dataBase, built.dataBase)
})

// ── 提取缓存（ensureAsarTreeCache——host-doctor asar 层的地基）───────────────
test('(MAINT-043) ensureAsarTreeCache：首轮提取 + marker 落盘（源路径+size+mtime+prefix）', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('3.0.0-test') },
  ])
  const cacheDir = join(dir, 'cache')
  const result = await ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' })
  assert.equal(result.reused, false)
  assert.equal(result.root, join(cacheDir, 'dsh', 'node_modules'))
  assert.equal(result.stats.extracted, 1)
  const marker = JSON.parse(readFileSync(join(cacheDir, ASAR_CACHE_MARKER), 'utf8'))
  assert.equal(marker.version, 1)
  assert.equal(marker.asar, built.asarPath)
  assert.equal(marker.size, readFileSync(built.asarPath).length)
  assert.equal(marker.prefix, 'dsh/node_modules')
  assert.ok(Number.isFinite(marker.mtimeMs))
  assert.equal(readFileSync(join(result.root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), dshMetaPackageJson('3.0.0-test'))
})

test('(MAINT-043) ensureAsarTreeCache：marker 命中（size+mtime 未变）→ 复用零重提取', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('3.0.0-test') },
  ])
  const cacheDir = join(dir, 'cache')
  await ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' })
  const sentinel = join(cacheDir, 'sentinel-proof-of-reuse.txt')
  writeFileSync(sentinel, '若复用生效，本哨兵不被清除')
  const second = await ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' })
  assert.equal(second.reused, true)
  assert.equal(existsSync(sentinel), true, 'marker 命中时不得清缓存重提取')
})

test('(MAINT-043) ensureAsarTreeCache：源归档 mtime 变脏 → 清缓存重提取', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: dshMetaPackageJson('3.0.0-test') },
  ])
  const cacheDir = join(dir, 'cache')
  await ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' })
  const sentinel = join(cacheDir, 'sentinel-stale.txt')
  writeFileSync(sentinel, '源归档升级后本哨兵应随缓存一起被清')
  const future = new Date(Date.now() + 60_000)
  utimesSync(built.asarPath, future, future)
  const second = await ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' })
  assert.equal(second.reused, false)
  assert.equal(existsSync(sentinel), false, '脏检查失败必须清空缓存重提取')
})

test('(MAINT-043) ensureAsarTreeCache：unpacked 缺失 → 拒绝产出半残树（不写 marker）', async (t) => {
  const dir = tempDir(t)
  const built = buildMicroAsar(dir, [
    { path: 'dsh/node_modules/gone.bin', content: 'X', unpacked: true },
  ])
  rmSync(built.unpackedRoot, { recursive: true, force: true })
  const cacheDir = join(dir, 'cache')
  await assert.rejects(
    () => ensureAsarTreeCache({ asarPath: built.asarPath, cacheDir, prefix: 'dsh/node_modules' }),
    (error) => error?.code === 'ASAR_UNPACKED_MISSING' && Array.isArray(error.missingPaths),
  )
  assert.equal(existsSync(join(cacheDir, ASAR_CACHE_MARKER)), false, '半残树不得写 marker（防后续轮复用）')
})
