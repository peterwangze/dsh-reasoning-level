/**
 * ESM resolve 钩子：仅把宿主行 lib/index.js（非存根自身）的
 * @deepseek-ai/dsh-settings 导入重定向到无 settingsNamespace 导出的存根。
 * 存根自己的再导出走标准解析（next），不会回到本钩子的重定向分支。
 */
const SPECIFIER = '@deepseek-ai/dsh-settings'

export async function resolve(specifier, context, next) {
  if (specifier === SPECIFIER && context.parentURL !== undefined && !context.parentURL.includes('dsh-settings-no-brand')) {
    return { url: new URL('./dsh-settings-no-brand.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
