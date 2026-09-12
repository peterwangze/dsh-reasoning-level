/**
 * 子进程加载器：把 lib/index.js 对 @deepseek-ai/dsh-settings 的导入重定向到
 * 无 settingsNamespace 导出的存根（模拟 0.1.2-rc.1+ 宿主），然后加载宿主行。
 * 加载成功打印 IMPORT OK；失败则以非零退出码 + stderr 报告（含原始错误消息）。
 */
import { register } from 'node:module'

register(new URL('./redirect-no-brand.mjs', import.meta.url).href)

try {
  await import('../../lib/index.js')
  console.log('IMPORT OK')
  // FEAT-001（§3.5-3）：接缝迁入 host-compat 后，诊断面 origin 在同一重定向
  // 存根下必须报告 local-fallback（包内导出缺席 → 本地同源回退生效）。
  const hostCompat = await import('../../lib/host-compat.js')
  console.log('SETTINGS NAMESPACE ORIGIN: ' + hostCompat.settingsNamespaceOrigin)
} catch (error) {
  console.error('IMPORT FAILED: ' + String(error?.message ?? error))
  process.exitCode = 1
}
