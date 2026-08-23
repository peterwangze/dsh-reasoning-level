/**
 * ESM 解析回退钩子（F8 测试基建，不随产品代码发布）。
 *
 * 背景：dsh-reasoning-level 遵循 DSH out-of-tree 契约——`dependencies` 恒为空，
 * 宿主包（@deepseek-ai/*）由 DSH 维护的 `$DSH_HOME/profiles/node_modules` 平坦
 * 回退树解析（插件自身零安装副作用）。仓库及父目录因此没有任何 node_modules；
 * 若按标准 Node 解析，import('@deepseek-ai/schemastery') 等全部失败。
 *
 * 本钩子先走标准解析（next），失败时回退到平坦树，使 `node --test test/`
 * 无需任何安装/软链即可加载 lib/index.js。
 * 平坦树根目录按 $DSH_HOME 优先、缺省 ~/.dsh（T2——与 lib/index.js 的
 * resolveDshHomeSafe 同源语义：非空字符串即生效）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** $DSH_HOME 显式优先（非空字符串），缺省 ~/.dsh —— 与产品代码同源语义（T2）。 */
export function dshHomeOf(env = process.env, home = homedir()) {
  const value = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined
  return value !== undefined ? value : join(home, '.dsh')
}

const TREE = join(dshHomeOf(), 'profiles', 'node_modules')

/** 拆包名与子路径：'@a/b/sub' -> { name: '@a/b', sub: 'sub' }；'x/sub' -> { name: 'x', sub: 'sub' } */
function parseName(specifier) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return { name: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') }
  }
  return { name: parts[0] ?? '', sub: parts.slice(1).join('/') }
}

/** 从 package.json 挑 import 入口（exports['.'] -> module -> main -> index.js）。 */
function pickEntry(pkg) {
  const dot = pkg.exports !== null && typeof pkg.exports === 'object' && pkg.exports['.'] !== undefined
    ? pkg.exports['.']
    : undefined
  const flatten = (e) => (typeof e === 'string' ? e : e?.import ?? e?.default ?? e?.require)
  const entry = typeof dot === 'string' ? dot : (dot !== undefined ? flatten(dot) : flatten(pkg.module ?? pkg.main))
  return typeof entry === 'string' ? entry : (pkg.main ?? 'index.js')
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (typeof specifier !== 'string' || specifier.startsWith('node:') || specifier.startsWith('.')) throw error
    const { name, sub } = parseName(specifier)
    if (name === '') throw error
    const pkgDir = join(TREE, name)
    try {
      let entry
      if (sub !== '') {
        entry = sub
      } else {
        entry = pickEntry(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')))
      }
      let candidate = join(pkgDir, entry)
      if (!existsSync(candidate) && !candidate.endsWith('.js') && existsSync(candidate + '.js')) candidate += '.js'
      return { url: pathToFileURL(candidate).href, shortCircuit: true }
    } catch (error2) {
      throw error
    }
  }
}
