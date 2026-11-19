/**
 * asar-fixtures — 微型 asar 归档构造器（MAINT-043 测试专用）。
 *
 * 按真实格式拼 Buffer（与 scripts/extract-asar.mjs 头格式注释同源，原型已在
 * 本机 209MB 真归档实测）：
 *   [0..3]   尺寸 pickle 载荷长（恒 4）   [4..7]  头 pickle 总长 H
 *   [8..11]  头 pickle 载荷长（= H−4）    [12..15] JSON 字节长
 *   [16..]   JSON 头（payload = 4B 长度前缀 + JSON + 4 字节对齐零垫）
 *   blob 基址 = 8 + H，其后顺序拼接 packed 条目内容；unpacked 条目实体由
 *   构造器写进 <dir>/app.asar.unpacked/<同路径>。
 *
 * 与生产读取器刻意独立实现（判别原则：测试构造 ≠ 被测物解析的两份拷贝）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 构造微型 asar 归档。
 * files: [{ path: 'a/b.txt', content: string|Buffer, unpacked?: true }]
 * 返回 { asarPath, unpackedRoot, dataBase, header }。
 * unpacked 条目内容自动落到 <dir>/app.asar.unpacked/<path>。
 */
export function buildMicroAsar(dir, files) {
  const header = { files: {} }
  const blobParts = []
  let blobOffset = 0
  const insertEntry = (segments, entry) => {
    let node = header
    for (const segment of segments.slice(0, -1)) {
      node.files[segment] ??= { files: {} }
      node = node.files[segment]
    }
    node.files[segments[segments.length - 1]] = entry
  }
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')
    const segments = file.path.split('/')
    if (file.unpacked === true) {
      // unpacked 条目：头内仅记 size+unpacked（offset 占位 0，实体在外部目录）
      insertEntry(segments, { offset: '0', size: content.length, unpacked: true })
      const external = join(dir, 'app.asar.unpacked', ...segments)
      mkdirSync(dirname(external), { recursive: true })
      writeFileSync(external, content)
      continue
    }
    insertEntry(segments, { offset: String(blobOffset), size: content.length })
    blobParts.push(content)
    blobOffset += content.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const jsonPrefix = Buffer.alloc(4)
  jsonPrefix.writeUInt32LE(json.length, 0)
  const unpadded = Buffer.concat([jsonPrefix, json])
  const padding = Buffer.alloc((4 - (unpadded.length % 4)) % 4)
  const payload = Buffer.concat([unpadded, padding])
  const payloadPrefix = Buffer.alloc(4)
  payloadPrefix.writeUInt32LE(payload.length, 0)
  const headerPickle = Buffer.concat([payloadPrefix, payload]) // H = 4 + payload.length
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  const dataBase = 8 + headerPickle.length
  const asarPath = join(dir, 'app.asar')
  mkdirSync(dir, { recursive: true })
  writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...blobParts]))
  return { asarPath, unpackedRoot: join(dir, 'app.asar.unpacked'), dataBase, header }
}

/** 读合法归档 → 定点改写一个 4 字节 LE 值 → 落盘新文件（防御校验负相）。 */
export function patchU32le(sourcePath, destPath, offset, value) {
  const buf = readFileSync(sourcePath)
  buf.writeUInt32LE(value, offset)
  writeFileSync(destPath, buf)
  return destPath
}

/** 便捷内容：一个最小的 @deepseek-ai/dsh 元包 package.json 文本。 */
export function dshMetaPackageJson(version) {
  return `${JSON.stringify({ name: '@deepseek-ai/dsh', version, private: true }, null, 2)}\n`
}
