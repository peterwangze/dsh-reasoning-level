/**
 * T2（R1 §2）：resolve-fallback.mjs 以 $DSH_HOME 优先、缺省 ~/.dsh。
 *  - 单元：dshHomeOf 三态（显式 DSH_HOME / 空串回退 / 缺省回退）；
 *  - 集成（子进程）：DSH_HOME 指向临时伪造树（profiles/node_modules 最小包）时，
 *    钩子从该树解析包——直接证明优先级语义；
 *  - 反向：DSH_HOME 未设置时伪造包解析失败（回退树 = 真实 ~/.dsh，无该包；
 *    CI 无树时同样失败）——证明回退不会误命中外部位置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

test('(T2-1) dshHomeOf：$DSH_HOME 非空字符串优先；空串/缺省回退 ~/.dsh', async () => {
  const mod = await import('./resolve-fallback.mjs')
  assert.equal(typeof mod.dshHomeOf, 'function')
  assert.equal(mod.dshHomeOf({ DSH_HOME: 'C:\\custom-dsh' }, 'H:\\home'), 'C:\\custom-dsh')
  assert.equal(mod.dshHomeOf({ DSH_HOME: '' }, 'H:\\home'), join('H:\\home', '.dsh'))
  assert.equal(mod.dshHomeOf({}, 'H:\\home'), join('H:\\home', '.dsh'))
})

test('(T2-2) $DSH_HOME 优先：临时伪造树（profiles/node_modules 最小包）被钩子解析', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-rl-t2-'))
  try {
    const pkgDir = join(tmpRoot, 'profiles', 'node_modules', '@fake-scope', 'fake-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@fake-scope/fake-pkg', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export default "fake"')
    const hookUrl = new URL('./resolve-fallback.mjs', import.meta.url).href
    const script = `
      import { register } from 'node:module'
      register(${JSON.stringify(hookUrl)})
      const m = await import('@fake-scope/fake-pkg')
      console.log('RESOLVE=' + (m.default === 'fake' ? 'OK' : 'WRONG'))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, DSH_HOME: tmpRoot },
      cwd: tmpRoot,
      encoding: 'utf8',
    })
    assert.match(out, /RESOLVE=OK/)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('(T2-3) 反向：DSH_HOME 未设置时伪造包不解析（回退树为真实 ~/.dsh，无该包）', async () => {
  const env = { ...process.env }
  delete env.DSH_HOME
  const hookUrl = new URL('./resolve-fallback.mjs', import.meta.url).href
  const script = `
    import { register } from 'node:module'
    register(${JSON.stringify(hookUrl)})
    try { await import('@fake-scope/fake-pkg'); console.log('RESOLVE=UNEXPECTED') }
    catch (e) { console.log('RESOLVE=FAIL:' + (e.code || e.name)) }
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env,
    cwd: tmpdir(),
    encoding: 'utf8',
  })
  assert.match(out, /RESOLVE=FAIL:/)
  assert.doesNotMatch(out, /RESOLVE=UNEXPECTED/)
})
