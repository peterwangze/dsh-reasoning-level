/**
 * UI 预览（开发辅助，不参与 `node --test`）——把 `lib/client.js` 的 STYLESHEET 与
 * UX-004 模型中心工作台的**真实列结构**固化成静态 HTML，再用 Playwright 截图，
 * 用于肉眼校验布局（设置页需要登录态，client-smoke 只能证明结构不抛错）。
 *
 *   node scripts/ui-preview.mjs                  # 820px 面板（窄布局：详情展开行）
 *   node scripts/ui-preview.mjs --width 1080     # 指定面板宽度（>1000 → 宽布局右侧详情）
 *
 * 产出：tmp/ui-preview*.html（始终）+ tmp/ui-preview*.png（Playwright 可用时）。
 * 每个页面都执行横向溢出检查（scrollWidth ≤ clientWidth），溢出即 exit 1。
 *
 * @module dsh-reasoning-level/scripts/ui-preview
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
const chips = (list, variant) => list.map((item) => chip(item, variant)).join('')
const escaped = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))

const LEVELS = ['关闭', '极低', '低', '中', '高', '极高', '最大']
const PARAMS = [
  { id: 'temperature', label: '温度', value: '0.7', hint: '越低越稳定，越高越发散', active: true },
  { id: 'topP', label: 'Top P', value: '0.95', hint: '宿主 0.2.2 的 GenerateOptions 无 topP 字段', active: false },
  { id: 'topK', label: 'Top K', value: '40', hint: '宿主 0.2.2 的 GenerateOptions 无 topK 字段', active: false },
  { id: 'maxTokens', label: '最大输出', value: '128k', hint: '单次响应的输出上限（tokens）', active: true },
]

// ── 模型列表：4 个 provider × 多模型（长列表滚动/筛选场景）──────────────────
const MODELS = []
const providers = ['zai-coding-cn', 'command-code', 'craze-code', 'deepseek-official', 'openai-codex', 'kimi', 'qwen']
const names = ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-pro', 'gpt-6.1-sol', 'claude-opus-5', 'kimi-k3', 'qwen4-max']
for (let index = 0; index < 15; index += 1) {
  const provider = providers[index % providers.length]
  const base = names[index % names.length]
  MODELS.push({
    key: provider + '/' + base + (index >= names.length ? '-v' + Math.floor(index / names.length) : ''),
    provider,
    name: base.toUpperCase() + (index >= names.length ? ' · ' + (Math.floor(index / names.length) + 1) : ''),
    image: index % 3 === 0,
    override: index % 5 === 0,
    effort: index % 7 === 0 ? 'max' : 'follow',
    temp: index % 4 === 0 ? '0.3' : '0.7',
    context: '200k',
    maxTokens: '128k',
  })
}
const selectedIndex = 1

function effortSelect(model) {
  return `<select class="rl-select" aria-label="思考强度 · ${escaped(model.key)}">
    <option value="follow">跟随全局思考强度（最大）</option>
    ${LEVELS.map((label, index) => `<option${model.effort === ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'][index] ? ' selected' : ''}>${label}</option>`).join('')}
  </select>`
}

function paramSummary(model) {
  return `温度 ${model.temp} · Top P 0.95 · Top K 40 · 最大输出 128k`
}

function modelRow(model, withInlineDetail) {
  const summary = model.override
    ? '自定义 · 思考 ' + (model.effort === 'follow' ? '高' : (model.effort === 'max' ? '最大' : '高')) + ' · 温度 ' + model.temp
    : '全局 · 最大 · 温度 0.7'
  const row = `
  <div class="rl-model-row${withInlineDetail ? ' rl-model-row-active' : ''}" data-model-key="${escaped(model.key)}">
    <div class="rl-model-ident">
      <button type="button" class="rl-model-open" aria-expanded="${withInlineDetail ? 'true' : 'false'}">
        <span class="rl-model-name">${escaped(model.name)}</span>
        <span class="rl-model-id">${escaped(model.key)}</span>
      </button>
    </div>
    <div class="rl-model-cell rl-model-source">
      <select class="rl-select" aria-label="配置来源 · ${escaped(model.key)}">
        <option${model.override ? '' : ' selected'}>跟随全局</option>
        <option${model.override ? ' selected' : ''}>自定义</option>
      </select>
    </div>
    <div class="rl-model-summary" title="${escaped(summary)}">${escaped(summary)}</div>
  </div>`
  return row + (withInlineDetail ? inlineDetail(model) : '')
}

function paramRow(param) {
  return `
  <div class="rl-param-row">
    <div class="rl-param-main">
      <div class="rl-param-label">采样参数 · ${param.label} <span class="rl-chip ${param.active ? 'rl-chip-success' : 'rl-chip-warning'}">${param.active ? '生效' : '预留'}</span></div>
      <div class="rl-field-hint" title="${escaped(param.hint)}">生效值 ${param.value}（来源：模型覆盖）</div>
    </div>
    <div class="rl-param-controls">
      <input type="text" inputmode="decimal" class="rl-input-num" value="${param.value}" aria-label="${param.label}">
      <button type="button" class="rl-btn rl-btn-ghost rl-btn-sm" aria-pressed="false">改为跟随全局默认（${param.value}）</button>
    </div>
  </div>`
}

function detailBody(model) {
  return `
  <div class="rl-detail-head">
    <div>
      <h4 class="rl-detail-title">${escaped(model.name)}</h4>
      <div class="rl-model-id">${escaped(model.key)}</div>
    </div>
    <div class="rl-card-actions">${chip('该模型有覆盖：思考 高', 'primary')}<button type="button" class="rl-btn rl-btn-ghost rl-btn-sm" aria-label="关闭详情">✕</button></div>
  </div>
  <div class="rl-detail-grid">
    <div class="rl-kv"><div class="rl-kv-label">身份</div><div class="rl-kv-value">${escaped(model.key)}</div></div>
    <div class="rl-kv"><div class="rl-kv-label">上下文</div><div class="rl-kv-value">${model.context}</div></div>
    <div class="rl-kv"><div class="rl-kv-label">最大输出</div><div class="rl-kv-value">${model.maxTokens}</div></div>
  </div>
  <div class="rl-field">
    <div class="rl-field-label">思考强度</div>
    ${effortSelect(model)}
    <div class="rl-field-hint">来源：自定义 · 生效值：高</div>
  </div>
  <div class="rl-field">
    <div class="rl-field-label">多模态</div>
    <select class="rl-select" aria-label="多模态 · ${escaped(model.key)}">
      <option>跟随目录（文本）</option>
      <option>自定义 · 仅文本</option>
      <option selected>自定义 · 文本 + 图像</option>
    </select>
    <div class="rl-field-hint">来源：自定义 · 生效值：文本 + 图像</div>
  </div>
  <div class="rl-field">
    <div class="rl-field-label">采样参数</div>
    ${PARAMS.map(paramRow).join('')}
  </div>
  <div class="rl-pills">
    <button type="button" class="rl-btn rl-btn-danger rl-btn-sm">恢复此模型默认</button>
    <span class="rl-muted">清除该模型的思考等级、多模态与采样参数覆盖</span>
  </div>`
}

function inlineDetail(model) {
  return `<section class="rl-detail rl-detail-inline" aria-label="模型详情">${detailBody(model)}</section>`
}
function asideDetail(model) {
  return `<aside class="rl-workbench-detail" aria-label="模型详情"><section class="rl-detail">${detailBody(model)}</section></aside>`
}

function providerGroups(compact) {
  const groups = new Map()
  for (const model of MODELS) {
    const provider = model.provider || model.key.split('/')[0]
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  return [...groups.entries()].map(([provider, models]) => {
    return `
    <div class="rl-provider" data-provider="${escaped(provider)}">
      <div class="rl-provider-head"><span>${escaped(provider)}</span><span class="rl-provider-count">${models.length} 个模型</span></div>
      ${models.map((model) => modelRow(model, compact && model.key === MODELS[selectedIndex].key)).join('')}
    </div>`
  }).join('')
}

function workbench(compact) {
  return `
  <div class="rl-workbench${compact ? ' rl-workbench-single rl-workbench-narrow' : ''}">
    <div class="rl-workbench-list">
      <div class="rl-status rl-status-warn">模型信息端点不可用，已降级使用会话模型目录（部分字段不可用）</div>
      <div class="rl-toolbar">
        <div class="rl-toolbar-main">
          <div class="rl-search-wrap rl-search-grow"><input type="search" class="rl-search" placeholder="搜索模型（名称 / 模型提供商 / id）"></div>
          <select class="rl-select" aria-label="模型提供商筛选"><option>全部模型提供商</option>${providers.map((p) => `<option>${p}</option>`).join('')}</select>
          <button type="button" class="rl-btn rl-btn-secondary rl-btn-sm" aria-pressed="false">仅显示自定义</button>
        </div>
        <span class="rl-toolbar-meta">显示 ${MODELS.length} / ${MODELS.length} 个模型</span>
      </div>
      ${providerGroups(compact)}
    </div>
    ${compact ? '' : asideDetail(MODELS[selectedIndex])}
  </div>`
}

function defaultsView() {
  return `
  <div class="rl-cards">
    <section class="rl-card">
      <h3 class="rl-card-title">全局默认思考强度</h3>
      <div class="rl-switch-field">
        <div class="rl-switch-line"><span class="rl-switch-text">启用统一默认推理等级</span><button type="button" class="rl-switch rl-switch-on" role="switch" aria-checked="true"><span class="rl-switch-thumb"></span></button></div>
        <div class="rl-switch-hint">新调用将使用默认等级</div>
      </div>
      <div class="rl-field">
        <div class="rl-field-label">默认推理等级（全局）</div>
        <div class="rl-seg" role="radiogroup" aria-label="默认推理等级（全局）">
          ${LEVELS.map((label, index) => `<button type="button" role="radio" aria-checked="${index === 4}" class="rl-seg-item${index === 4 ? ' rl-seg-checked' : ''}"><span class="rl-seg-name">${label}</span><span class="rl-seg-sub">${['不思考', '一笔带过', '轻量推理', '常规推理', '深度推理', '更深推理', '最深推理'][index]}</span></button>`).join('')}
        </div>
        <div class="rl-impact"><span class="rl-impact-text">影响预览：15 个模型支持「高」</span></div>
      </div>
      <div class="rl-switch-field">
        <div class="rl-switch-line"><span class="rl-switch-text">同步默认 agent 模型等级</span><button type="button" class="rl-switch" role="switch" aria-checked="false"><span class="rl-switch-thumb"></span></button></div>
        <div class="rl-switch-hint">开启后全局等级变化会同步写入 agent-default-model.reasoningEffort</div>
      </div>
      <div class="rl-applied">已应用：zai-coding-cn=高 / 15 个模型 · DeepSeek 官方：设置为 高</div>
    </section>
    <section class="rl-card">
      <h3 class="rl-card-title">全局默认采样参数（模型未覆盖时生效）</h3>
      <div class="rl-preset-row" role="group" aria-label="采样预设">
        <button type="button" class="rl-preset" aria-pressed="false">精确</button>
        <button type="button" class="rl-preset rl-preset-active" aria-pressed="true">均衡</button>
        <button type="button" class="rl-preset" aria-pressed="false">创意</button>
        <span class="rl-preset rl-preset-custom">自定义</span>
      </div>
      <div class="rl-field-hint">预设作用于全局默认参数；模型覆盖始终优先。</div>
      <div class="rl-subtitle">全局默认采样参数（模型未覆盖时生效）</div>
      ${PARAMS.map((param) => `
      <div class="rl-param-row">
        <div class="rl-param-main">
          <div class="rl-param-label">采样参数 · ${param.label} <span class="rl-chip ${param.active ? 'rl-chip-success' : 'rl-chip-warning'}">${param.active ? '生效' : '预留'}</span></div>
          <div class="rl-field-hint">生效值 ${param.value}（来源：全局默认）</div>
        </div>
        <div class="rl-param-controls">
          <input type="text" inputmode="decimal" class="rl-input-num" value="${param.value}" aria-label="采样参数 · ${param.label}">
          <button type="button" class="rl-btn rl-btn-secondary rl-btn-sm">沿用宿主默认</button>
        </div>
      </div>`).join('')}
      <div class="rl-field-hint">留空 = 沿用宿主/调用方默认；本插件只填充调用方未显式给出的值。</div>
    </section>
    <section class="rl-card">
      <h3 class="rl-card-title">辅助调用等级</h3>
      <div class="rl-field-row"><span class="rl-field-row-label">压缩 compaction</span><select class="rl-select"><option>关闭</option><option>跟随全局</option></select><span class="rl-muted">辅助调用（压缩 compaction）用此等级</span></div>
      <div class="rl-field-row"><span class="rl-field-row-label">标题 session-title</span><select class="rl-select"><option>跟随全局</option></select></div>
      <div class="rl-hint">辅助模型调用（会话压缩、标题生成）可独立设置等级，如用 off 省 token。</div>
    </section>
    <section class="rl-card">
      <h3 class="rl-card-title">优先级说明</h3>
      <div class="rl-hint">优先级：模型级参数 &gt; 全局默认参数 &gt; 宿主/调用方已给值（不覆盖）。</div>
      <div class="rl-hint">思考等级：会话/模型选择器显式选择 &gt; 模型级默认 &gt; 全局默认。</div>
    </section>
  </div>`
}

function diagnosticsView() {
  return `
  <div class="rl-cards">
    <section class="rl-card"><h3 class="rl-card-title">宿主契约健康</h3><div class="rl-status rl-status-ok">契约正常</div></section>
    <section class="rl-card"><h3 class="rl-card-title">端点状态</h3><div class="rl-endpoint-line"><span>模型信息: 不可用</span><span class="rl-chip rl-chip-warning">降级到会话模型目录</span><span>统计: 可用</span></div></section>
  </div>
  <section class="rl-card">
    <h3 class="rl-card-title">扩展注册表</h3>
    <div class="rl-field-hint">端点不可用，使用内置注册表降级</div>
    <div class="rl-subtitle">参数注册表</div>
    <div class="rl-table-wrap"><table class="rl-table rl-registry-table">
      <thead><tr><th class="rl-th">标识</th><th class="rl-th">名称</th><th class="rl-th">状态</th><th class="rl-th">说明</th></tr></thead>
      <tbody>${PARAMS.map((param) => `<tr><td class="rl-td">${param.id}</td><td class="rl-td">${param.label}</td><td class="rl-td"><span class="rl-chip ${param.active ? 'rl-chip-success' : 'rl-chip-warning'}">${param.active ? '生效' : '预留'}</span></td><td class="rl-td rl-cell-error">${escaped(param.hint)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`
}

function tabs(active) {
  return `<div class="rl-tabs" role="tablist" aria-label="视图切换">
    ${[['models', '模型'], ['defaults', '默认与预设'], ['observability', '观测'], ['diagnostics', '诊断']].map(([id, label]) => `<button type="button" role="tab" id="rl-tab-${id}" aria-controls="rl-panel-${id}" aria-selected="${id === active}" class="rl-tab${id === active ? ' rl-tab-active' : ''}" tabindex="${id === active ? 0 : -1}">${label}</button>`).join('')}
  </div>`
}

function pageHtml({ active, panel }) {
  // 真实设置页 modal 场景：视口 1440px 但容器仅 559~800px，媒体查询不会触发窄布局；
  // 这里按**容器宽度**选择 compact（与 React 侧 ResizeObserver 判定同一阈值）。
  const compact = panel < 1000
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-reasoning-level · UX-004 UI preview</title>
<style>
  body { margin: 0; padding: 24px; display: flex; justify-content: center; background: #ffffff; color: #1a1a1a; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif }
  .panel { width: ${panel}px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 16px; background: #fafafa }
  .gap { height: 16px }
  ${stylesheet}
</style></head>
<body><div class="panel"><div class="rl-root rl-page">
  <header class="rl-header">
    <div class="rl-header-main">
      <div><h2 class="rl-header-title">统一模型管理</h2><p class="rl-header-sub">一个设置页管理所有模型的思考强度、多模态能力与采样参数</p></div>
      <div class="rl-header-actions"><div class="rl-pills"><button class="rl-btn rl-btn-secondary rl-btn-sm">刷新</button><button class="rl-btn rl-btn-primary">一键探测全部模型并固化配置</button></div></div>
    </div>
    <div class="rl-pills">
      <span class="rl-pill rl-pill-ok"><span class="rl-pill-dot"></span>启用中</span>
      <span class="rl-pill rl-pill-primary"><span class="rl-pill-dot"></span>默认：高</span>
      <span class="rl-pill rl-pill-muted"><span class="rl-pill-dot"></span>生效 7 个模型提供商 · 15 个模型</span>
    </div>
  </header>
  <div class="rl-stats-grid">
    <div class="rl-stat"><div class="rl-stat-label">思考档位分布</div><div class="rl-stat-value">高</div><div class="rl-stat-sub">5 / 15 模型自定义</div><div class="rl-scale" aria-hidden="true">${LEVELS.map((_, index) => `<span class="rl-scale-seg${index <= 4 ? ' rl-scale-seg-on' : ''}"></span>`).join('')}</div></div>
    <div class="rl-stat"><div class="rl-stat-label">多模态启用</div><div class="rl-stat-value">8</div><div class="rl-stat-sub">8 / 15 模型启用图像输入</div></div>
    <div class="rl-stat"><div class="rl-stat-label">参数覆盖</div><div class="rl-stat-value">5</div><div class="rl-stat-sub">5 个模型自定义 · 3 项全局默认</div></div>
    <div class="rl-stat"><div class="rl-stat-label">契约健康</div><div class="rl-stat-value">降级</div><div class="rl-stat-sub rl-stat-sub-warn">1 项缺失</div></div>
  </div>
  ${tabs(active)}
  ${active === 'models' ? `<section id="rl-panel-models" role="tabpanel" aria-labelledby="rl-tab-models" class="rl-panel"><section class="rl-card"><h3 class="rl-card-title">模型</h3><div class="rl-field-hint">按模型提供商分组的模型级默认；点击行编辑思考强度、多模态与采样参数</div>${workbench(compact)}<details class="rl-disclosure"><summary class="rl-disclosure-summary">高级：按 模型提供商/模型 键精确管理（可选）</summary></details></section></section>` : ''}
  ${active === 'defaults' ? `<section id="rl-panel-defaults" role="tabpanel" aria-labelledby="rl-tab-defaults" class="rl-panel">${defaultsView()}</section>` : ''}
  ${active === 'diagnostics' ? `<section id="rl-panel-diagnostics" role="tabpanel" aria-labelledby="rl-tab-diagnostics" class="rl-panel">${diagnosticsView()}</section>` : ''}
</div></div></body></html>`
}

const outDir = join(root, 'tmp')
mkdirSync(outDir, { recursive: true })
const targets = [
  { name: 'ui-preview', panel: panelWidth },
  { name: 'ui-preview-wide', panel: 1280 },
  { name: 'ui-preview-narrow', panel: 420 },
  // 真实设置页场景：1440×1200 视口 + 559/800px 容器（媒体查询不触发，必须靠容器判定）。
  { name: 'ui-preview-modal-800', panel: 800, viewportWidth: 1440, viewportHeight: 1200 },
  { name: 'ui-preview-modal-559', panel: 559, viewportWidth: 1440, viewportHeight: 1200 },
]
for (const target of targets) {
  const html = pageHtml({ active: 'models', panel: target.panel })
  writeFileSync(join(outDir, target.name + '.html'), html, 'utf8')
  console.log('ui-preview: wrote tmp/' + target.name + '.html (panel ' + target.panel + 'px, ' + (target.panel < 1000 ? 'compact' : 'wide') + ' layout)')
}
const defaultsHtml = pageHtml({ active: 'defaults', panel: panelWidth })
writeFileSync(join(outDir, 'ui-preview-defaults.html'), defaultsHtml, 'utf8')
console.log('ui-preview: wrote tmp/ui-preview-defaults.html (defaults view, panel ' + panelWidth + 'px)')

// ── 截图 + 横向溢出检查（Playwright 缺失时只产出 HTML）────────────────────
// ESM `import('playwright')` 不读 NODE_PATH，所以按候选目录用 createRequire 解析：
// ①本仓库自身依赖 ②PLAYWRIGHT_HOME 环境变量 ③本机 dev_toolchain 约定位置。
const { createRequire } = await import('node:module')
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
let overflow = false
for (const target of [...targets, { name: 'ui-preview-defaults', panel: panelWidth }]) {
  const viewportWidth = target.viewportWidth ?? target.panel + 80
  const viewportHeight = target.viewportHeight ?? 900
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
  await page.goto('file:///' + join(outDir, target.name + '.html').replace(/\\/g, '/'))
  const metrics = await page.evaluate(() => {
    const workbench = document.querySelector('.rl-workbench')
    const row = document.querySelector('.rl-model-row')
    const list = document.querySelector('.rl-workbench-list')
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      workbenchClass: workbench !== null ? workbench.className : '',
      rowTracks: row !== null ? getComputedStyle(row).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      listWidth: list !== null ? Math.round(list.getBoundingClientRect().width) : 0,
    }
  })
  if (metrics.scrollWidth > metrics.clientWidth + 1) {
    console.error('ui-preview: horizontal overflow in ' + target.name + ' (' + metrics.scrollWidth + ' > ' + metrics.clientWidth + ') at panel ' + target.panel + 'px')
    overflow = true
  }
  // 容器级窄布局断言：narrow 下不得仍是 4 列；容器 559/800px 时列表不得被空详情列挤成窄条。
  const narrowClass = metrics.workbenchClass.split(/\s+/).includes('rl-workbench-narrow')
  if (narrowClass && metrics.rowTracks > 2) {
    console.error('ui-preview: narrow workbench must not keep a 4-column model row — ' + target.name + ' tracks=' + metrics.rowTracks)
    overflow = true
  }
  if (target.panel >= 500 && target.panel < 1000 && narrowClass && metrics.listWidth < 300) {
    console.error('ui-preview: compact workbench list collapsed to ' + metrics.listWidth + 'px — ' + target.name)
    overflow = true
  }
  await page.screenshot({ path: join(outDir, target.name + '.png'), fullPage: true })
  await page.close()
  console.log('ui-preview: wrote tmp/' + target.name + '.png (viewport ' + viewportWidth + '×' + viewportHeight + ', panel ' + target.panel + 'px, list ' + metrics.listWidth + 'px, row tracks ' + metrics.rowTracks + ', scrollWidth ' + metrics.scrollWidth + ')')
}
await browser.close()
if (overflow) process.exit(1)
