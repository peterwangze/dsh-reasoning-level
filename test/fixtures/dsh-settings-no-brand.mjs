/**
 * 新一代 dsh-settings（0.2.0-rc.2）的导出面形状存根：仅
 * SettingsConflictError / SettingsForms（含 default）/ redactSecrets——
 * 不导出 settingsNamespace（0.1.2-rc.1 起移除）。
 *
 * 用于回归守护「宿主行在无品牌导出的 dsh-settings 下仍可加载」这一升级
 * 兼容契约（MAINT-021；MAINT-035 起存根形状同步 0.2.0 导出面——SettingsProvider
 * 已移除）：存根从本仓库实际安装的 dsh-settings 再导出，无论 devDependencies
 * 装的是哪一代，存根形状恒等于新一代宿主。
 */
export { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets } from '@deepseek-ai/dsh-settings'
