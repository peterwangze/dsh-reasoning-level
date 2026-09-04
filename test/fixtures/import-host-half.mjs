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
} catch (error) {
  console.error('IMPORT FAILED: ' + String(error?.message ?? error))
  process.exitCode = 1
}
