#!/usr/bin/env node
/**
 * extract-asar — Electron asar 归档读取/提取器（MAINT-043 产品化；原型
 * tmp/extract-asar.mjs 已在本机实测：D:\app\dsh\resources\app.asar 209MB，
 * dsh/node_modules 前缀 18896 文件 + 1666 unpacked 拷贝零缺失）。
 *
 * 背景：DSH 桌面版（0.2.2-rc.1 起）宿主包树全量内化 app.asar 归档，文件系统
 * 上不再存在 node 可直接读取的宿主包树——本模块提供 asar 感知的读取/提取
 * 能力，供 scripts/host-doctor.mjs 活树解析 v2 程序化调用，亦可独立 CLI 使用。
 *
 * 零 npm 依赖：仅 node:fs / node:fs/promises / node:path / node:url。
 *
 * asar 头格式（Chromium Pickle；偏移均 4 字节 LE，MAINT-043 实测锚定）：
 *   offset 0   尺寸 pickle 载荷长（恒 4——载荷是单个 uint32）
 *   offset 4   头 pickle 总长 H
 *   offset 8   头 pickle 载荷长（= H − 4）
 *   offset 12  头 JSON 字节长
 *   offset 16  起：UTF-8 JSON 头 {files:{<名>:{files:{…}} | {offset,size,unpacked?}}}
 *   文件 blob 基址 = 8 + H；文件条目 offset 是相对基址的十进制字符串。
 *   unpacked:true 条目实体在归档同级 app.asar.unpacked\<同路径>（提取时拷贝回填）。
 *
 * 防御性校验（AsarFormatError，error.code === 'ASAR_FORMAT'，结构化 details）：
 * 文件过短 / 尺寸 pickle 载荷 ≠ 4 / 头载荷 ≠ H−4 / JSON 超出头载荷 / blob
 * 基址越界 / 条目 offset/size 非法或越界——一律 fail-closed 抛错，绝不静默
 * 产出错树。
 *
 * CLI：
 *   node scripts/extract-asar.mjs <archive.asar> [--probe]
 *   node scripts/extract-asar.mjs <archive.asar> <outDir> [--prefix <p>]
 *   --probe：仅解析头输出统计，不落盘。退出码：0 成功；1 unpacked 条目缺失；
 *   2 用法/格式错误。
 *
 * @module dsh-reasoning-level/scripts/extract-asar
 */
import { open, stat, mkdir, rm, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** 结构化格式错误（fail-closed：不猜格式、不静默产出错树）。 */
export class AsarFormatError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AsarFormatError'
    this.code = 'ASAR_FORMAT'
    this.details = details
  }
}

/**
 * 解析 asar 头（16 字节 pickle 前缀 + JSON 头），带全部防御校验。
 * 返回 { archive（绝对路径）, size, mtimeMs, header, dataBase, headerPickleSize, jsonSize }。
 */
export async function readAsarHeader(archive) {
  const fileStat = await stat(archive).catch(() => {
    throw new AsarFormatError(`asar 归档不存在或不可读：${archive}`, { archive })
  })
  if (fileStat.size < 20) {
    throw new AsarFormatError(`asar 头过短（文件 ${fileStat.size} 字节 < 20，无法容纳 pickle 前缀）——可能不是 asar 归档`, { archive, size: fileStat.size })
  }
  const fh = await open(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    await fh.read(head, 0, 16, 0)
    const sizePicklePayload = head.readUInt32LE(0)   // 恒 4
    const headerPickleSize = head.readUInt32LE(4)    // H
    const headerPayloadSize = head.readUInt32LE(8)   // = H − 4
    const jsonSize = head.readUInt32LE(12)           // JSON 字节长
    if (sizePicklePayload !== 4) {
      throw new AsarFormatError(
        `asar 头防御校验失败：尺寸 pickle 载荷长 = ${sizePicklePayload}（期望恒 4）——文件可能不是 asar 归档或布局漂移`,
        { archive, offset: 0, value: sizePicklePayload, expected: 4 },
      )
    }
    if (headerPayloadSize !== headerPickleSize - 4) {
      throw new AsarFormatError(
        `asar 头防御校验失败：头 pickle 载荷长 ${headerPayloadSize} ≠ 头总长 ${headerPickleSize} − 4`,
        { archive, offset: 8, headerPickleSize, headerPayloadSize },
      )
    }
    if (4 + jsonSize > headerPayloadSize) {
      throw new AsarFormatError(
        `asar 头防御校验失败：JSON 长 ${jsonSize} + 4 超出头载荷 ${headerPayloadSize}`,
        { archive, jsonSize, headerPayloadSize },
      )
    }
    const headerBuf = Buffer.alloc(jsonSize)
    await fh.read(headerBuf, 0, jsonSize, 16)
    let header
    try {
      header = JSON.parse(headerBuf.toString('utf8'))
    } catch (error) {
      throw new AsarFormatError(`asar 头 JSON 解析失败：${error?.message ?? error}`, { archive, jsonSize })
    }
    if (header === null || typeof header !== 'object' || Array.isArray(header) || header.files === null || typeof header.files !== 'object' || Array.isArray(header.files)) {
      throw new AsarFormatError('asar 头 JSON 形状异常（缺 files 对象）', { archive })
    }
    const dataBase = 8 + headerPickleSize
    if (dataBase > fileStat.size) {
      throw new AsarFormatError(
        `asar 头防御校验失败：blob 基址 ${dataBase} 超出文件尺寸 ${fileStat.size}`,
        { archive, dataBase, size: fileStat.size },
      )
    }
    return { archive: resolve(archive), size: fileStat.size, mtimeMs: fileStat.mtimeMs, header, dataBase, headerPickleSize, jsonSize }
  } finally {
    await fh.close()
  }
}

/**
 * 深度遍历头 files 树，产出 [{relPath（/ 分隔）, entry}]——仅文件条目
 * （目录节点以 entry.files 在场区分，不单独产出）。
 */
export function walkAsarFiles(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relPath = prefix === '' ? name : `${prefix}/${name}`
      if (entry !== null && typeof entry === 'object' && entry.files !== undefined) walk(entry, relPath)
      else out.push({ relPath, entry })
    }
  }
  walk(header, '')
  return out
}

/**
 * 提取归档中 prefix 前缀下的全部文件到 outDir（保持归档内相对路径）。
 *  · packed 条目：按 offset/size 从 blob 区读取（越界防御校验）；
 *  · unpacked 条目：从归档同级 app.asar.unpacked/<同路径> 拷贝（unpackedRoot 可覆盖）。
 * 返回 { extracted, unpackedCopied, unpackedMissing, missingPaths, bytes, totalFiles, underPrefix }。
 * unpacked 缺失仅计数与记录路径不抛错——由调用方（ensureAsarTreeCache / CLI）裁决。
 */
export async function extractAsar({ archive, outDir, prefix = '', unpackedRoot }) {
  const info = await readAsarHeader(archive)
  const files = walkAsarFiles(info.header)
  const selected = files.filter(({ relPath }) => prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`))
  const unpackedBase = unpackedRoot ?? join(dirname(info.archive), 'app.asar.unpacked')
  await mkdir(outDir, { recursive: true })
  const fh = await open(archive, 'r')
  const result = {
    extracted: 0, unpackedCopied: 0, unpackedMissing: 0, missingPaths: [],
    bytes: 0, totalFiles: files.length, underPrefix: selected.length,
  }
  try {
    for (const { relPath, entry } of selected) {
      const dest = join(outDir, ...relPath.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      if (entry?.unpacked === true) {
        const src = join(unpackedBase, ...relPath.split('/'))
        if (!existsSync(src)) {
          result.unpackedMissing += 1
          result.missingPaths.push(relPath)
          continue
        }
        await copyFile(src, dest)
        result.unpackedCopied += 1
        continue
      }
      const size = Number(entry?.size)
      const offset = Number(entry?.offset)
      if (!Number.isInteger(size) || size < 0 || !Number.isInteger(offset) || offset < 0) {
        throw new AsarFormatError(
          `asar 条目 offset/size 非法（${relPath}：offset=${entry?.offset} size=${entry?.size}）`,
          { archive: info.archive, relPath },
        )
      }
      if (info.dataBase + offset + size > info.size) {
        throw new AsarFormatError(
          `asar 条目越界（${relPath}：blob 基址 ${info.dataBase} + offset ${offset} + size ${size} > 文件尺寸 ${info.size}）`,
          { archive: info.archive, relPath },
        )
      }
      const buf = Buffer.alloc(size)
      if (size > 0) await fh.read(buf, 0, size, info.dataBase + offset)
      await writeFile(dest, buf)
      result.extracted += 1
      result.bytes += size
    }
  } finally {
    await fh.close()
  }
  return result
}

/**
 * 仅解析头输出统计（不落盘）：{ totalFiles, unpacked, underPrefix, dataBase, size }。
 */
export async function probeAsar(archive, prefix = '') {
  const info = await readAsarHeader(archive)
  const files = walkAsarFiles(info.header)
  let unpacked = 0
  let underPrefix = 0
  for (const { relPath, entry } of files) {
    if (entry?.unpacked === true) unpacked += 1
    if (prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`)) underPrefix += 1
  }
  return { totalFiles: files.length, unpacked, underPrefix, dataBase: info.dataBase, size: info.size }
}

/** doctor 提取缓存的 marker 文件名（位于 cacheDir 根）。 */
export const ASAR_CACHE_MARKER = 'doctor-asar-cache.json'

/**
 * asar 提取缓存（host-doctor 活树源 v2，MAINT-043）：
 *  · marker（cacheDir/doctor-asar-cache.json）记录源归档绝对路径 + size +
 *    mtimeMs + prefix + 提取统计；与当前归档 stat 完全一致且提取根在场 →
 *    复用（零重提取——本机全量一轮约 180MB/数十秒，之后秒级命中）；
 *  · 任一不匹配（归档升级/换源/prefix 变更/缓存残缺）→ 清空 cacheDir 重提取；
 *  · 提取出现 unpackedMissing → 抛错（code 'ASAR_UNPACKED_MISSING'）且**不写
 *    marker**——半残树不得被后续轮复用。
 * 返回 { reused, root（提取出的树根 = cacheDir/<prefix 段>）, cacheDir, marker, stats }。
 */
export async function ensureAsarTreeCache({ asarPath, cacheDir, prefix }) {
  const resolvedAsar = resolve(asarPath)
  const asarStat = await stat(resolvedAsar) // 缺失 → ENOENT 原样上抛（调用方存在性检查前置）
  const root = join(cacheDir, ...prefix.split('/'))
  const markerPath = join(cacheDir, ASAR_CACHE_MARKER)
  const marker = await readFile(markerPath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
  if (
    marker !== null
    && marker.version === 1
    && marker.asar === resolvedAsar
    && marker.size === asarStat.size
    && marker.mtimeMs === asarStat.mtimeMs
    && marker.prefix === prefix
    && existsSync(root)
  ) {
    return { reused: true, root, cacheDir, marker, stats: marker.stats ?? null }
  }
  await rm(cacheDir, { recursive: true, force: true })
  const stats = await extractAsar({ archive: resolvedAsar, outDir: cacheDir, prefix })
  if (stats.unpackedMissing > 0) {
    throw Object.assign(
      new Error(
        `asar unpacked 条目缺失 ${stats.unpackedMissing} 个（源 ${resolvedAsar}，如 ${stats.missingPaths.slice(0, 3).join(', ')}）——app.asar.unpacked 与归档不配套，拒绝产出半残树`,
      ),
      { code: 'ASAR_UNPACKED_MISSING', missingPaths: stats.missingPaths },
    )
  }
  const nextMarker = {
    version: 1,
    asar: resolvedAsar,
    size: asarStat.size,
    mtimeMs: asarStat.mtimeMs,
    prefix,
    extractedAt: new Date().toISOString(),
    stats: {
      extracted: stats.extracted,
      unpackedCopied: stats.unpackedCopied,
      bytes: stats.bytes,
      underPrefix: stats.underPrefix,
    },
  }
  await writeFile(markerPath, `${JSON.stringify(nextMarker, null, 2)}\n`, 'utf8')
  return { reused: false, root, cacheDir, marker: nextMarker, stats }
}

// ── CLI（一次性使用；host-doctor 走程序化导出）──────────────────────────────
const CLI_USAGE = [
  '用法：node scripts/extract-asar.mjs <archive.asar> [--probe] [--prefix <p>]',
  '      node scripts/extract-asar.mjs <archive.asar> <outDir> [--prefix <p>]',
  '  --probe    仅解析头输出统计，不落盘（无需 outDir）',
  '  --prefix   仅提取该前缀下的条目（如 dsh/node_modules；默认全量）',
].join('\n')

function parseCliArgs(argv) {
  const out = { archive: undefined, outDir: undefined, prefix: '', probe: false, help: false, errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--probe') out.probe = true
    else if (arg === '--prefix') {
      const value = argv[i + 1]
      if (value === undefined || value === '') out.errors.push('--prefix 需要一个参数')
      else { out.prefix = value; i += 1 }
    } else if (arg.startsWith('--prefix=')) {
      const value = arg.slice('--prefix='.length)
      if (value === '') out.errors.push('--prefix= 需要一个参数')
      else out.prefix = value
    } else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('-') && arg !== '-') out.errors.push(`未知参数：${arg}`)
    else if (out.archive === undefined) out.archive = arg
    else if (out.outDir === undefined) out.outDir = arg
    else out.errors.push(`多余参数：${arg}`)
  }
  return out
}

async function cliMain() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    console.log(CLI_USAGE)
    process.exit(0)
  }
  if (args.errors.length > 0 || args.archive === undefined || (!args.probe && args.outDir === undefined)) {
    console.error(`extract-asar: 参数错误——${args.errors.join('；') || '缺少 archive/outDir（--probe 模式无需 outDir）'}\n${CLI_USAGE}`)
    process.exit(2)
  }
  try {
    if (args.probe) {
      const stats = await probeAsar(args.archive, args.prefix)
      console.log(`probe ${stats.size} bytes：totalFiles=${stats.totalFiles} unpacked=${stats.unpacked} underPrefix(${args.prefix || '*'})=${stats.underPrefix} dataBase=${stats.dataBase}`)
      process.exit(0)
    }
    const stats = await extractAsar({ archive: args.archive, outDir: args.outDir, prefix: args.prefix })
    console.log(`extracted=${stats.extracted} (${(stats.bytes / 1048576).toFixed(1)} MB) unpackedCopied=${stats.unpackedCopied} unpackedMissing=${stats.unpackedMissing}`)
    if (stats.unpackedMissing > 0) {
      console.error(`缺失 unpacked 条目（前 10）：${stats.missingPaths.slice(0, 10).join(', ')}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (error) {
    if (error instanceof AsarFormatError) {
      console.error(`extract-asar: ${error.message}${Object.keys(error.details).length > 0 ? `（details：${JSON.stringify(error.details)}）` : ''}`)
      process.exit(2)
    }
    console.error(`extract-asar: ${error?.message ?? error}`)
    process.exit(2)
  }
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) await cliMain()
