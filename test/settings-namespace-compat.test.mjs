/**
 * MAINT-021 回归守护：DSH 0.1.2-rc.1 起 dsh-settings 从公共导出面移除
 * settingsNamespace（连同 installSettingsSection / deepEqualJson）。
 * 宿主行曾以静态具名 import 消费它——导出缺席时是模块**加载期**
 * SyntaxError，插件行加载失败升级为 profile 挂载失败 → 整机 DSH 拉不起
 * （用户 2026-09-05 实测；probe 复现 "does not provide an export named
 * 'settingsNamespace'"）。
 *
 * 本测试在子进程中以「无 settingsNamespace 导出」的 dsh-settings 存根
 * （test/fixtures/dsh-settings-no-brand.mjs）加载 lib/index.js，断言加载
 * 成功。守护不依赖本机 devDependencies 安装的是哪一代 dsh-settings——
 * 即使 devDep 回退到旧版（settingsNamespace 存在），存根形状仍模拟新版，
 * 该契约持续被测试（防止 devDep 版本漂移让守护悄然失效）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('./fixtures/import-host-half.mjs', import.meta.url))

test('(MAINT-021) 宿主行在无 settingsNamespace 导出的 dsh-settings（0.1.2-rc.1+ 形状）下可加载', async () => {
  const { stdout, stderr, exitCode } = await new Promise((resolve) => {
    execFile(process.execPath, [RUNNER], {}, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error === null ? 0 : (error.code ?? 1) })
    })
  })
  assert.equal(exitCode, 0, `host half failed to import under new-generation dsh-settings shape: ${stderr}`)
  assert.match(stdout, /IMPORT OK/)
  // FEAT-001（设计 §3.5-3）：接缝迁入 lib/host-compat.js 后，诊断面
  // settingsNamespaceOrigin 在旧宿主形状存根下必须报告 local-fallback——
  // 包内导出缺席 → 本地同源回退校验器生效（迁移前后生效路径零变更）。
  assert.match(
    stdout,
    /SETTINGS NAMESPACE ORIGIN: local-fallback/,
    'settingsNamespaceOrigin 应报告 local-fallback（存根无 settingsNamespace 导出，回退路径必须生效）',
  )
})
