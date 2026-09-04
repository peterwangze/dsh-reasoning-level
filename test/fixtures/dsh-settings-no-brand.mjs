/**
 * 新一代 dsh-settings（0.1.2-rc.1+）的导出面形状存根：仅
 * SettingsConflictError / SettingsProvider（含 default）/ redactSecrets——
 * 不再导出 settingsNamespace。
 *
 * 用于回归守护「宿主行在无品牌导出的 dsh-settings 下仍可加载」这一升级
 * 兼容契约（MAINT-021）：存根从本仓库实际安装的 dsh-settings 再导出，
 * 无论 devDependencies 装的是哪一代，存根形状恒等于新一代宿主。
 */
export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets } from '@deepseek-ai/dsh-settings'
