/**
 * UI 预览（开发辅助，不参与 CI）——把 `lib/client.js` 里的 STYLESHEET 与表格结构
 * 渲染成静态 HTML，再用 Playwright 截图，用于**肉眼校验布局**。
 *
 * 为什么需要它：client.js 只能内联/注入样式，宿主设置页又需要登录态，自动化测试
 * （client-smoke）只能证明「渲染不抛错」，无法证明「表格没被挤成一列 chips」。
 * 本脚本把真实样式表 + 真实列结构固化成可截图的静态页，改 CSS 后能立刻看到效果。
 *
 *    node scripts/ui-preview.mjs                 # 输出 tmp/ui-preview.html + tmp/ui-preview.png
 *    node scripts/ui-preview.mjs --width 820     # 指定面板宽度（模拟设置页内容区）
 *
 * 依赖：Playwright（本机 dev_toolchain 的 node-with-playwright 包装器）；
 * 缺失时只产出 HTML 并提示，不失败。
 *
 * @module dsh-reasoning-level/scripts/ui-preview
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

/** 从 client.js 抽出 STYLESHEET 模板字面量内容（唯一事实源，禁止复制粘贴）。 */
function extractStylesheet(text) {
  const start = text.indexOf('const STYLESHEET = `')
  if (start < 0) throw new Error('ui-preview: STYLESHEET not found in lib/client.js')
  const from = start + 'const STYLESHEET = `'.length
  const end = text.indexOf('`', from)
  if (end < 0) throw new Error('ui-preview: unterminated STYLESHEET')
  return text.slice(from, end)
}

const widthArg = process.argv.indexOf('--width')
const panelWidth = widthArg > 0 ? Number(process.argv[widthArg + 1]) : 820

const stylesheet = extractStylesheet(source)

const chip = (label, variant) => `<span class="rl-chip${variant ? ' rl-chip-' + variant : ''}">${label}</span>`
const chips = (list, variant) => list.map((l) => chip(l, variant)).join('')

// ── 复刻「探测结果」表（数据取自真实 lastProbe 的三种典型形态）──────────────
const probeRows = [
  {
    model: 'zai-coding-cn/glm-5.3-flash',
    working: ['关闭', '极低', '低', '中', '高', '极高', '最大'],
    rejected: [],
    blocked: '',
    persisted: '已与实测一致',
  },
  {
    model: 'command-code/deepseek/deepseek-v4.1-flash',
    working: ['关闭', '低', '中', '高', '极高', '最大'],
    rejected: ['极低'],
    blocked: '',
    persisted: '已固化',
  },
  {
    model: 'craze-code/gpt-6.1-sol',
    working: ['中', '高', '极高', '最大'],
    rejected: [],
    blocked: chip('关闭', 'warning') + chip('极低', 'warning') + chip('低', 'warning') + '<div class="rl-cell-sub">连接失败（网络/证书/DNS）——检查网络或代理</div>',
    persisted: '已固化',
  },
]

const probeTable = `
<div class="rl-table-wrap">
  <table class="rl-table rl-probe-table">
    <thead>
      <tr>
        <th class="rl-th rl-col-key">模型</th>
        <th class="rl-th rl-col-levels">实测可用等级</th>
        <th class="rl-th rl-col-unavailable">不可用（红=拒绝 / 黄=失败）</th>
        <th class="rl-th rl-col-persisted">持久化</th>
      </tr>
    </thead>
    <tbody>
      ${probeRows.map((r) => `
      <tr>
        <td class="rl-td rl-cell-key">${r.model}</td>
        <td class="rl-td"><div class="rl-chips">${chips(r.working, 'success')}</div></td>
        <td class="rl-td rl-cell-error">${r.rejected.length ? `<div class="rl-chips">${chips(r.rejected, 'danger')}</div>` : ''}${r.blocked}</td>
        <td class="rl-td rl-col-persisted">${r.persisted}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`

// ── 复刻「模型聚合」表（真实数据 + 紧凑数字格式）──────────────────────────
const statRows = [
  { model: 'zai-coding-cn/glm-5.3', calls: '20.1k', dist: [['(默认)×63', ''], ['最大×20.1k', 'primary'], ['关闭×1', '']], think: '~30.9M 字', out: '17.6M', dur: '18.9s' },
  { model: 'deepseek-official/deepseek-flash', calls: '19.6k', dist: [['(默认)×40', ''], ['最大×19.6k', 'primary'], ['关闭×2', '']], think: '9.26M tok', out: '20.7M', dur: '13.8s' },
  { model: 'zai-coding-cn/glm-5.3-flash', calls: '10.8k', dist: [['最大×10.8k', 'primary'], ['(默认)×4', '']], think: '~23.8M 字', out: '11.6M', dur: '27.4s' },
  { model: 'command-code/deepseek/deepseek-v4.1-flash', calls: '7285', dist: [['最大×7275', 'primary'], ['(默认)×10', '']], think: '~11.0M 字', out: '7.52M', dur: '17.1s' },
]

const statsTable = `
<div class="rl-table-wrap">
  <table class="rl-table rl-stats-table">
    <thead>
      <tr>
        <th class="rl-th rl-col-key">模型</th>
        <th class="rl-th rl-col-num"><button class="rl-sort-btn" aria-sort="descending">调用 ↓</button></th>
        <th class="rl-th rl-col-levels">等级分布</th>
        <th class="rl-th rl-col-num">思考</th>
        <th class="rl-th rl-col-num">输出</th>
        <th class="rl-th rl-col-num">平均耗时</th>
        <th class="rl-th rl-col-num">错误率%</th>
      </tr>
    </thead>
    <tbody>
      ${statRows.map((r) => `
      <tr>
        <td class="rl-td rl-cell-key">${r.model}</td>
        <td class="rl-td rl-col-num">${r.calls}</td>
        <td class="rl-td"><div class="rl-chips">${r.dist.map(([l, v]) => chip(l, v)).join('')}</div></td>
        <td class="rl-td rl-col-num">${r.think}</td>
        <td class="rl-td rl-col-num">${r.out}</td>
        <td class="rl-td rl-col-num">${r.dur}</td>
        <td class="rl-td rl-col-num">0</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>dsh-reasoning-level UI preview</title>
<style>
  body { margin: 0; padding: 24px; background: #ffffff; color: #1a1a1a; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif }
  .panel { width: ${panelWidth}px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 16px; background: #fafafa }
  ${stylesheet}
</style></head>
<body><div class="panel"><div class="rl-root">
  <div class="rl-card"><h3 class="rl-card-title">实测探测（复刻）</h3>${probeTable}</div>
  <div class="rl-card" style="margin-top:16px"><h3 class="rl-card-title">模型聚合（复刻）</h3>${statsTable}</div>
</div></div></body></html>`

const outDir = join(root, 'tmp')
mkdirSync(outDir, { recursive: true })
const htmlPath = join(outDir, 'ui-preview.html')
writeFileSync(htmlPath, html, 'utf8')
console.log('ui-preview: wrote ' + htmlPath + ' (panel ' + panelWidth + 'px)')

// ── 截图（Playwright 缺失时只产出 HTML）──────────────────────────────────
// ESM `import('playwright')` 不读 NODE_PATH，所以按候选目录用 createRequire 解析：
// ①本仓库自身依赖 ②PLAYWRIGHT_HOME 环境变量 ③本机 dev_toolchain 约定位置。
const { createRequire } = await import('node:module')
const { existsSync } = await import('node:fs')
function loadPlaywright() {
  const bases = [import.meta.url]
  if (process.env.PLAYWRIGHT_HOME) bases.unshift(join(process.env.PLAYWRIGHT_HOME, 'package.json'))
  const toolchain = 'D:/AI/dev_toolchain/browser_test_tool_list'
  if (existsSync(toolchain)) bases.push(join(toolchain, 'package.json'))
  for (const base of bases) {
    try {
      return createRequire(base)('playwright')
    } catch (error) { /* 换下一个候选 */ }
  }
  return undefined
}
const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('ui-preview: Playwright 不可用，跳过截图（HTML 已生成，可手动打开；或设 PLAYWRIGHT_HOME 指向含 playwright 的目录）')
  process.exit(0)
}
const browser = await playwright.chromium.launch()
const page = await browser.newPage({ viewport: { width: panelWidth + 80, height: 900 }, deviceScaleFactor: 1 })
await page.goto('file:///' + htmlPath.replace(/\\/g, '/'))
const pngPath = join(outDir, 'ui-preview.png')
await page.screenshot({ path: pngPath, fullPage: true })
await browser.close()
console.log('ui-preview: wrote ' + pngPath)
