/**
 * dsh-reasoning-level 浏览器侧包（`./client`，dual-face 下发）。
 *
 * 「设置 → 统一推理等级」单页签（settings.section list slot）：
 * - 全局：总开关（enabled）+ 默认推理等级（level）；
 * - 模型级默认：按 "provider/model" 覆盖全局默认（下拉：跟随全局 + 各等级），
 *   列表来自 llm 域的 providers/models（含休眠路由），写入 llm-reasoning.models；
 * - 实时调用统计：轮询宿主 /reasoning-level-stats——最近调用的实际推理等级、
 *   思考/输出 tokens、结束原因，以及按模型的聚合（等级分布 / 思考 tokens 合计）。
 *
 * wire 面（MAINT-022）：宿主客户端 typed remote 命名空间（remote.settings
 * describe/update/mutate + remote.session.modelCatalog——hostApiFace 单点
 * 收敛为旧信封 {result:{ok,value|error}}）+ 直连 stats 端点。
 *
 * 渲染层（UX-001）：现代卡片式 + 明暗自适应。设计令牌集中在 `theme`（色板/间距/
 * 圆角/字号阶梯），组件样式一律由 `styles` / `btnStyle` 派生复用；全部颜色为
 * 半透明灰阶 + currentColor + 语义色半透明变体——不读取宿主 CSS 变量或主题 API
 * （无文档保证，见执行包 assumption_record）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reasoning-level',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const el = react.createElement
    const { useState, useEffect, useRef } = react

    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const LEVEL_LABELS = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', follow: '跟随全局' }
    const levelLabel = (l) => (LEVEL_LABELS[l] || l)

    // ── 轻量 i18n：zh/en 双字典，缺省 zh ──────────────────────────────
    const LANG = {
      zh: {
        enable: '启用统一默认推理等级',
        level: '默认推理等级（全局）',
        syncAgent: '同步默认 agent 模型等级',
        globalSettings: '全局设置',
        modelDefaults: '模型级默认',
        purposeLevels: '辅助调用等级',
        stats: '实时调用统计',
        recentCalls: '最近调用',
        title: '统一推理等级',
        addModel: '添加模型默认',
        selectModel: '选择 provider/model',
        loadModels: '加载模型列表（探测能力）…',
        add: '添加',
        delete: '删除',
        test: '测试',
        testing: '测试中…',
        export: '导出 CSV',
        follow: '跟随全局',
        noModels: '未配置模型级默认；所有未显式选择等级的调用使用全局默认。',
        priority: '优先级：会话/模型选择器显式选择 > 模型级默认 > 全局默认。标注 ⚠ 的配置在运行时会被自动跳过（保持全局默认）。',
        purposeHint: '辅助模型调用（会话压缩、标题生成）可独立设置等级，如用 off 省 token。',
        statsHint: '统计中的“推理等级”是该次请求实际携带的等级（会话显式选择或默认物化后的最终值）。',
        testingNote: '一键探测会对每个模型发 1-token 实测请求验证全部候选等级，结束后把可用等级固化进模型能力声明；不同模型可独立使用实际支持的等级。导出可下载 CSV。',
        model: '模型', calls: '调用', effortDist: '等级分布', think: '思考', output: '输出', avgDur: '平均耗时', suggestion: '建议',
        thinkTokens: '思考tokens', thinkChars: '思考字符', outputTokens: '输出tokens', avgDurMs: '平均耗时ms', errRateCol: '错误率%',
        time: '时间', effort: '推理等级', duration: '耗时', result: '结果',
        blacklist: '⚠ 实测黑名单：', since: '自', totalCalls: '共', callsSuffix: '次调用（每 2s 刷新）',
        rejectEntry: (k, v) => `${k} 拒绝 ${v}`,
        semiSep: '；',
        errHigh: (n) => `错误率 ${n}% 偏高，建议降低等级`,
        rejectSug: (rej, hi) => `实测拒绝 ${rej.join('/')}，建议用最高档 ${hi ?? '（默认）'}`,
        supports: '支持：', unknown: '能力未知', noLevel: '（无推理等级）',
        defaultTag: '(默认)', charsUnit: ' 字',
        testOk: (t, l, d) => `✓ ${t} · ${l} 可用（${d}ms）`,
        testFail: (t, l, e) => `✗ ${t} · ${l} 不可用${e ? '：' + e : ''}`,
        blacklisted: '（已入黑名单）',
        probeAll: '一键探测全部模型并固化配置',
        probing: (i, n, k) => `探测中 ${i}/${n}：${k}`,
        probeDone: (n, w) => `探测完成：${n} 个模型，固化 ${w} 处模型能力声明；实测拒绝的等级仅作为该次探测结果（不入黑名单），运行时自愈（真实调用失败会临时跳过该档，重启即清零）。`,
        probeEmpty: '没有可探测的模型（模型列表加载失败或为空）。',
        probeFail: '探测请求失败',
        probeApplyFail: '固化配置失败',
        comma: '，',
        paren: (s) => `（${s}）`,
        probeColModel: '模型', probeColWorking: '实测可用等级', probeColRejected: '实测拒绝', probeColBlocked: '其他错误',
        probeLabel: '实测探测',
        probeResultsTitle: '探测结果',
        probeFooter: (n) => `（${n} 个模型 · 实测用 1-token 请求）`,
        probeNote: '探测拒绝不入黑名单、不持久化；运行时自愈——真实调用被网关拒绝后临时跳过该档（仅当前会话生效）。可用的等级写回该模型能力声明（手写声明自动并入新档位）。',
        probeNoteSummary: '探测说明',
        prioritySummary: '优先级与模型能力说明',
        hintSummary: '说明',
        colModelCap: '模型（实测支持等级）',
        colDefaultLevel: '默认等级',
        colActions: '操作',
        modelCapNote: '每个模型可选等级来自宿主实时解析的模型能力（pi-ai 目录 + 本插件声明），不同模型不同：只会出现实测支持的档位；',
        unsupportedOpt: ' ⚠ 不支持，将跳过',
        addHint: (e, h) => `该模型支持：${e} → 默认填入最高档「${h}」`,
        purposeCompaction: '压缩 compaction',
        purposeTitle: '标题 session-title',
        purposeActive: (label) => `辅助调用（${label}）用此等级`,
        readFail: (m) => `读取失败：${m}`,
        unknownErr: '未知错误',
        readStatusFail: '读取状态失败',
        saveFail: (m) => `保存失败：${m}`,
        saveFailShort: '保存失败',
        savedNotice: '已保存，立即对后续请求生效',
        loading: '加载中…',
        statsLoading: '统计加载中…',
        statsUnavailable: '统计端点不可用（宿主未挂载 webServer 或插件未运行）。',
        summarizing: '统计中…',
        appliedSummary: (r, m, d) => `已应用：${r} 个路由 / ${m} 个模型 · DeepSeek 官方：${d}`,
        dsUnset: '未设置（保持原状）',
        dsSet: (l) => `设置为 ${l}`,
        pageHintMain: '说明：全局默认动态生效——修改后下一次模型请求即采用新等级。手写声明的模型自动补齐「推理等级」能力（含最大 Max）；',
        pageHintRoute: '每条路由只有在全部模型都支持该等级时才写入默认值。',
      },
      en: {
        enable: 'Enable unified default reasoning level',
        level: 'Default level (global)',
        syncAgent: 'Sync default agent model level',
        globalSettings: 'Global settings',
        modelDefaults: 'Per-model defaults',
        purposeLevels: 'Auxiliary call levels',
        stats: 'Live call statistics',
        recentCalls: 'Recent calls',
        title: 'Unified Reasoning Level',
        addModel: 'Add model default',
        selectModel: 'Select provider/model',
        loadModels: 'Loading models (probing)…',
        add: 'Add',
        delete: 'Delete',
        test: 'Test',
        testing: 'Testing…',
        export: 'Export CSV',
        follow: 'Follow global',
        noModels: 'No per-model defaults; calls without an explicit choice use the global default.',
        priority: 'Priority: explicit session/model selection > per-model default > global default. ⚠ entries are skipped at runtime (global default kept).',
        purposeHint: 'Auxiliary calls (compaction, session title) can set their own level, e.g. off to save tokens.',
        statsHint: 'The “level” in stats is what the request actually carried (explicit selection or materialized default).',
        testingNote: 'Probe-all sends a 1-token request per candidate level, then writes working levels back to capability declarations; different models may support different levels natively. Export downloads CSV.',
        model: 'Model', calls: 'Calls', effortDist: 'Effort dist', think: 'Think', output: 'Output', avgDur: 'Avg dur', suggestion: 'Suggestion',
        thinkTokens: 'Think tokens', thinkChars: 'Think chars', outputTokens: 'Output tokens', avgDurMs: 'Avg duration ms', errRateCol: 'Error rate%',
        time: 'Time', effort: 'Effort', duration: 'Duration', result: 'Result',
        blacklist: '⚠ Blacklist: ', since: 'Since', totalCalls: 'total', callsSuffix: 'calls (2s refresh)',
        rejectEntry: (k, v) => `${k} rejected ${v}`,
        semiSep: '; ',
        errHigh: (n) => `Error rate ${n}% high, consider lowering level`,
        rejectSug: (rej, hi) => `Rejected ${rej.join('/')} in practice, use highest ${hi ?? '(default)'}`,
        supports: 'Supports: ', unknown: 'capability unknown', noLevel: '(no reasoning level)',
        defaultTag: '(default)', charsUnit: ' chars',
        testOk: (t, l, d) => `✓ ${t} · ${l} OK (${d}ms)`,
        testFail: (t, l, e) => `✗ ${t} · ${l} failed${e ? ': ' + e : ''}`,
        blacklisted: ' (blacklisted)',
        probeAll: 'Probe all models & fix config',
        probing: (i, n, k) => `Probing ${i}/${n}: ${k}`,
        probeDone: (n, w) => `Probe complete: ${n} models, ${w} capability declarations updated; rejected levels are probe-only (not blacklisted), runtime self-healing (real failures skip the level for this session, resets on restart).`,
        probeEmpty: 'No models to probe (model list missing or empty).',
        probeFail: 'Probe request failed',
        probeApplyFail: 'Apply failed',
        comma: ', ',
        paren: (s) => ` (${s})`,
        probeColModel: 'Model', probeColWorking: 'Working levels', probeColRejected: 'Rejected', probeColBlocked: 'Other errors',
        probeLabel: 'Probe & fix',
        probeResultsTitle: 'Probe results',
        probeFooter: (n) => `(${n} models · 1-token requests)`,
        probeNote: 'Probe rejections are NOT blacklisted or persisted; runtime self-healing — real gateway failures temporarily skip the level (session-only, resets on restart). Working levels are written to capability declarations (hand-written declarations get new levels appended).',
        probeNoteSummary: 'About probe results',
        prioritySummary: 'Priority & capability notes',
        hintSummary: 'Notes',
        colModelCap: 'Model (measured levels)',
        colDefaultLevel: 'Default level',
        colActions: 'Actions',
        modelCapNote: 'Available levels come from host-resolved model capabilities (pi-ai catalog + this plugin\'s declarations) and differ per model; only measured-supported levels are listed. ',
        unsupportedOpt: ' ⚠ unsupported, will be skipped',
        addHint: (e, h) => `Supported: ${e} → defaults to highest "${h}"`,
        purposeCompaction: 'Compaction',
        purposeTitle: 'Session title',
        purposeActive: (label) => `Auxiliary calls (${label}) use this level`,
        readFail: (m) => `Read failed: ${m}`,
        unknownErr: 'unknown error',
        readStatusFail: 'Failed to read status',
        saveFail: (m) => `Save failed: ${m}`,
        saveFailShort: 'Save failed',
        savedNotice: 'Saved — effective for subsequent requests',
        loading: 'Loading…',
        statsLoading: 'Loading stats…',
        statsUnavailable: 'Stats endpoint unavailable (host webServer not mounted or plugin not running).',
        summarizing: 'Summarizing…',
        appliedSummary: (r, m, d) => `Applied: ${r} routes / ${m} models · DeepSeek official: ${d}`,
        dsUnset: 'not set (unchanged)',
        dsSet: (l) => `set to ${l}`,
        pageHintMain: 'Notes: the global default applies dynamically — the next model request uses the new level. Hand-written model declarations get reasoning levels auto-filled (including Max). ',
        pageHintRoute: 'A route only gets a default level when every model on it supports that level. ',
      },
    }
    function makeT(locale) {
      const dict = (locale === 'en' ? LANG.en : LANG.zh)
      return (key, ...args) => {
        const v = dict[key] !== undefined ? dict[key] : LANG.zh[key]
        return typeof v === 'function' ? v(...args) : v
      }
    }
    const zhT = makeT('zh')

    // ── 设计令牌（UX-001）：色板/间距/圆角/字号阶梯集中一处定义 ─────────────
    // 主题策略：明暗自适应不依赖宿主主题 API——灰阶一律半透明（在宿主底色上叠加），
    // 文本继承 currentColor；语义色用中明度色相的半透明变体（明/暗底均可读）。
    const theme = {
      color: {
        cardBg: 'rgba(128,128,128,0.08)',       // 卡片底
        zebra: 'rgba(128,128,128,0.06)',        // 表格斑马纹
        rowHover: 'rgba(128,128,128,0.1)',      // 表格行 hover
        border: 'rgba(128,128,128,0.35)',       // 分隔线/描边
        borderStrong: 'rgba(128,128,128,0.5)',  // 次按钮描边
        chipBg: 'rgba(128,128,128,0.14)',       // 中性徽章底
        primary: 'rgba(25,118,210,0.65)',       // 主色描边/强调条
        primaryBg: 'rgba(25,118,210,0.14)',     // 主按钮/高亮徽章底
        success: 'rgba(46,125,50,0.9)',         // 成功文本
        successBg: 'rgba(76,175,80,0.18)',      // 成功徽章底
        danger: 'rgba(198,40,40,0.9)',          // 错误文本
        dangerBg: 'rgba(229,57,53,0.16)',       // 错误徽章底
        dangerBorder: 'rgba(198,40,40,0.55)',   // 危险按钮描边
        warning: 'rgba(178,106,0,0.9)',         // 警告文本
        warningBg: 'rgba(255,167,38,0.18)',     // 警告徽章底
      },
      radius: { card: '10px', btn: '6px', chip: '4px' },
      space: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '14px', xxl: '16px' },
      fontSize: { xs: '11px', sm: '12px', md: '13px', lg: '14px' },
    }

    // 组件样式一律从 theme 派生（单处定义，禁止散落重复样式常量）
    const styles = {
      page: { padding: theme.space.xxl },
      card: { background: theme.color.cardBg, borderRadius: theme.radius.card, padding: theme.space.xxl, marginTop: theme.space.xxl },
      cardTitle: { display: 'flex', alignItems: 'center', gap: theme.space.md, fontSize: theme.fontSize.lg, fontWeight: 600, margin: '0 0 ' + theme.space.md },
      cardAccent: { width: '3px', height: '14px', borderRadius: '2px', background: theme.color.primary, flex: '0 0 auto' },
      subTitle: { fontSize: theme.fontSize.md, fontWeight: 600, margin: theme.space.xxl + ' 0 ' + theme.space.sm },
      row: { display: 'flex', alignItems: 'center', gap: theme.space.lg, margin: theme.space.lg + ' 0' },
      label: { minWidth: '150px', fontSize: theme.fontSize.md },
      select: { padding: theme.space.xs + ' ' + theme.space.md, borderRadius: theme.radius.chip, border: '1px solid ' + theme.color.border, background: 'transparent', color: 'inherit' },
      status: { fontSize: theme.fontSize.sm, opacity: 0.8, marginTop: theme.space.md },
      hint: { fontSize: theme.fontSize.sm, opacity: 0.65, marginTop: theme.space.xl, lineHeight: 1.6 },
      muted: { fontSize: theme.fontSize.sm, opacity: 0.65 },
      mutedBlock: { fontSize: theme.fontSize.sm, opacity: 0.65, marginTop: theme.space.sm },
      cellSub: { marginTop: theme.space.xs, lineHeight: 1.8 },
      table: { borderCollapse: 'collapse', width: '100%', fontSize: theme.fontSize.sm },
      th: { padding: theme.space.sm + ' ' + theme.space.lg, textAlign: 'left', fontWeight: 600, borderBottom: '1px solid ' + theme.color.border, whiteSpace: 'nowrap' },
      td: { padding: theme.space.sm + ' ' + theme.space.lg, textAlign: 'left', verticalAlign: 'top' },
      details: { marginTop: theme.space.xl },
      summary: { fontSize: theme.fontSize.sm, opacity: 0.75, cursor: 'pointer', userSelect: 'none' },
      loading: { padding: theme.space.xxl, fontSize: theme.fontSize.md, opacity: 0.7 },
    }

    // 按钮体系：统一 padding/圆角；主按钮半透明主色底（静态强化，不依赖 hover，
    // 简单可靠）；次按钮描边；危险按钮语义红描边。
    const btnStyle = (variant) => ({
      padding: theme.space.sm + ' ' + theme.space.xl,
      borderRadius: theme.radius.btn,
      cursor: 'pointer',
      fontSize: theme.fontSize.sm,
      ...(variant === 'primary'
        ? { background: theme.color.primaryBg, border: '1px solid ' + theme.color.primary, fontWeight: 600 }
        : variant === 'danger'
          ? { background: 'transparent', border: '1px solid ' + theme.color.dangerBorder, color: theme.color.danger }
          : { background: 'transparent', border: '1px solid ' + theme.color.borderStrong }),
    })

    // ── 通用展示组件 ────────────────────────────────────────────────────────
    /** 卡片分区：半透明底 + 圆角 + 左侧 accent 竖条标题。 */
    function Card(props) {
      const { title, children } = props
      return el('section', { style: styles.card },
        el('div', { style: styles.cardTitle },
          el('span', { style: styles.cardAccent }),
          el('span', null, title)),
        children)
    }

    /** 等级徽章：半透明底色替代纯文本斜杠拼接；variant 决定语义底色。 */
    const CHIP_BG = {
      neutral: theme.color.chipBg,
      primary: theme.color.primaryBg,
      success: theme.color.successBg,
      danger: theme.color.dangerBg,
      warning: theme.color.warningBg,
    }
    function LevelChip(props) {
      const { label, variant } = props
      return el('span', {
        style: {
          display: 'inline-block',
          padding: '1px 7px',
          marginRight: theme.space.xs,
          borderRadius: theme.radius.chip,
          background: CHIP_BG[variant] || CHIP_BG.neutral,
          fontSize: theme.fontSize.xs,
          lineHeight: 1.6,
        },
      }, label)
    }

    /** 表格行：斑马纹（奇数行）+ hover 高亮（内联样式无 :hover，用受控状态实现）。 */
    function TableRow(props) {
      const { index, children, ...rest } = props
      const [hover, setHover] = useState(false)
      const background = hover ? theme.color.rowHover : (index % 2 === 1 ? theme.color.zebra : undefined)
      return el('tr', {
        ...rest,
        style: { ...((rest && rest.style) || {}), background },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    function fmtTime(ts) {
      const d = new Date(ts)
      const p = (n) => (n < 10 ? '0' + n : String(n))
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    // ── 统计面板 ────────────────────────────────────────────────────────────
    /** 客户端单模型探测抓取超时：对齐服务端单模型最坏时长——候选级数上界 7（LEVELS）÷
     *  并发 3 = 3 波 × 30s（PROBE_TIMEOUT_MS）+ 5s 余量 = 95s；服务端中止后连接随即释放。 */
    const PROBE_FETCH_TIMEOUT_MS = 95000
    function StatsPanel(props) {
      const api = props.api
      const t = props.t || zhT
      const [stats, setStats] = useState(null)
      const [failed, setFailed] = useState(false)
      const [probeTargets, setProbeTargets] = useState([]) // [{provider, model, key}]
      const [probing, setProbing] = useState(false)
      const [probeProgress, setProbeProgress] = useState('')
      const [probeResults, setProbeResults] = useState([])
      const [probeSummary, setProbeSummary] = useState('')
      const [probeSummaryOk, setProbeSummaryOk] = useState(true)
      const timerRef = useRef(null)

      useEffect(() => {
        let alive = true
        const tick = () => {
          fetch('/reasoning-level-stats', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
            .then((data) => { if (alive) { setStats(data); setFailed(false) } })
            .catch(() => { if (alive) setFailed(true) })
        }
        tick()
        timerRef.current = window.setInterval(tick, 2000)
        return () => { alive = false; if (timerRef.current) window.clearInterval(timerRef.current) }
      }, [])

      useEffect(() => {
        let alive2 = true
        // 探测目标 = 全部可调用模型；跳过 id 以 '-router' 结尾的组（疑似路由包装组：能力与
        // 底层路由一致，避免重复实测烧请求）。该命名约定未能在本地 DSH 安装树确证——本环境中
        // 未发现任何以 '-router' 结尾的模型组 id（仅有插件/命名空间 id，如 dsh-agent-router、
        // vision-router）；属未证实的启发式，按观察保留，待上游/真实部署确认后再收紧或放宽。
        api.llm.models({}).then((response) => {
          if (!alive2) return
          if (!response.result.ok) { setProbeTargets([]); return }
          const groups = (response.result.value && response.result.value.groups) || []
          const targets = []
          for (const group of groups) {
            if (typeof group.id !== 'string' || group.id.endsWith('-router')) continue
            for (const model of group.models ?? []) {
              if (typeof model.id !== 'string' || model.id === '') continue
              targets.push({ provider: group.id, model: model.id, key: group.id + '/' + model.id })
            }
          }
          if (alive2) setProbeTargets(targets)
        }).catch(() => { if (alive2) setProbeTargets([]) })
        return () => { alive2 = false }
      }, [])

      const probeAll = () => {
        if (probing || probeTargets.length === 0) return
        setProbing(true)
        setProbeProgress('')
        setProbeSummary('')
        setProbeSummaryOk(true)
        setProbeResults([])
        ;(async () => {
          const results = []
          for (let i = 0; i < probeTargets.length; i++) {
            const target = probeTargets[i]
            setProbeProgress(t('probing', String(i + 1), String(probeTargets.length), target.key))
            // 每模型抓取超时（略大于服务端 30s）：服务端中止后连接随即释放，UI 不再永久悬挂
            const controller = new AbortController()
            const timer = window.setTimeout(() => controller.abort(), PROBE_FETCH_TIMEOUT_MS)
            try {
              const response = await fetch('/reasoning-level-stats/probe', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: target.provider, model: target.model }),
                signal: controller.signal,
              })
              const data = await response.json()
              // 服务端异常响应可能缺 key：以本地 target.key 兜底，保证结果表首列不空白
              results.push({ key: target.key, ...data })
            } catch (error) {
              results.push({ provider: target.provider, model: target.model, key: target.key, error: t('probeFail'), working: [], rejected: [], blocked: [] })
            } finally {
              window.clearTimeout(timer)
            }
            setProbeResults(results.slice())
          }
          let applyNote = ''
          try {
            const response = await fetch('/reasoning-level-stats/probe/apply', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results }),
            })
            const applied = await response.json()
            applyNote = t('comma') + t('probeDone', String(results.length), String(applied.writes ?? (applied.error ? '—' : 0)))
            if (applied.error !== undefined) {
              applyNote += t('paren', applied.error)
              setProbeSummaryOk(false)
            }
          } catch (error) {
            applyNote = t('comma') + t('probeApplyFail')
            setProbeSummaryOk(false)
          }
          setProbeSummary(applyNote)
          setProbeProgress('')
          setProbing(false)
        })()
      }

      const exportCsv = () => {
        const rows = [[t('model'), t('calls'), t('effortDist'), t('thinkTokens'), t('thinkChars'), t('outputTokens'), t('avgDurMs'), t('errRateCol')]]
        for (const [key, agg] of Object.entries(stats.models ?? {})) {
          rows.push([key, agg.calls, Object.entries(agg.efforts ?? {}).map(([k, v]) => k + '=' + v).join('|'),
            agg.reasoningTokens ?? 0, agg.reasoningChars ?? 0, agg.outputTokens ?? 0,
            agg.calls > 0 ? Math.round((agg.durationMs ?? 0) / agg.calls) : 0, agg.errRate ?? 0])
        }
        const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'reasoning-level-stats.csv'
        a.click()
        URL.revokeObjectURL(url)
      }

      if (failed && stats === null) {
        return el('div', { style: styles.hint }, t('statsUnavailable'))
      }
      if (stats === null) {
        return el('div', { style: styles.hint }, t('statsLoading'))
      }

      const modelRows = Object.entries(stats.models ?? {}).sort((a, b) => b[1].calls - a[1].calls)
      const blackEntries = Object.entries(stats.blacklist ?? {})
      const avgDuration = (agg) => (agg.calls > 0 && typeof agg.durationMs === 'number' ? Math.round(agg.durationMs / agg.calls) + 'ms' : '—')
      // 等级分布徽章：占比最高档高亮（primary），其余中性
      const distChips = (efforts) => {
        const entries = Object.entries(efforts)
        const maxCount = entries.reduce((m, [, v]) => Math.max(m, v), 0)
        return entries.map(([k, v]) => el(LevelChip, { key: k, label: levelLabel(k) + '×' + v, variant: v === maxCount ? 'primary' : 'neutral' }))
      }
      const levelChips = (list, variant) => (list ?? []).map((l) => el(LevelChip, { key: l, label: levelLabel(l), variant }))

      return el('div', null,
        el(Card, { title: t('probeLabel') },
          el('div', { style: styles.row },
            el('button', {
              type: 'button',
              disabled: probing || probeTargets.length === 0,
              onClick: probeAll,
              style: btnStyle('primary'),
            }, probing ? t('testing') : t('probeAll')),
            el('button', { type: 'button', onClick: exportCsv, style: btnStyle('primary') }, t('export')),
            el('span', { style: styles.muted }, t('probeFooter', String(probeTargets.length))),
          ),
          probeTargets.length === 0
            ? el('div', { style: styles.mutedBlock }, t('probeEmpty'))
            : null,
          probeProgress !== '' ? el('div', { style: styles.status }, probeProgress) : null,
          probeSummary !== '' ? el('div', { style: { ...styles.status, color: probeSummaryOk ? theme.color.success : theme.color.danger } }, probeSummary) : null,
          probeResults.length > 0
            ? el('div', null,
                el('div', { style: styles.subTitle }, t('probeResultsTitle')),
                el('table', { style: styles.table },
                  el('thead', null, el('tr', null,
                    el('th', { style: styles.th }, t('probeColModel')),
                    el('th', { style: styles.th }, t('probeColWorking')),
                    el('th', { style: styles.th }, t('probeColRejected')),
                    el('th', { style: styles.th }, t('probeColBlocked')),
                  )),
                  el('tbody', null, probeResults.map((r, i) => el(TableRow, { key: i, index: i },
                    el('td', { style: styles.td }, r.key),
                    el('td', { style: styles.td }, (r.working ?? []).length > 0 ? levelChips(r.working, 'success') : '—'),
                    el('td', { style: styles.td }, (r.rejected ?? []).length > 0 ? levelChips(r.rejected, 'danger') : '—'),
                    el('td', { style: styles.td }, (r.blocked ?? []).length > 0 ? levelChips(r.blocked, 'warning') : (r.error !== undefined ? r.error : '—')),
                  ))),
                ),
                el('details', { style: styles.details },
                  el('summary', { style: styles.summary }, t('probeNoteSummary')),
                  el('div', { style: styles.hint }, t('probeNote'))),
              )
            : null,
        ),
        el(Card, { title: t('stats') },
          el('div', { style: styles.status },
            t('since') + ' ' + fmtTime(stats.since) + ' ' + t('totalCalls') + ' ' + (stats.totalCalls ?? 0) + ' ' + t('callsSuffix')),
          blackEntries.length > 0
            ? el('div', { style: { ...styles.status, color: theme.color.warning } },
                t('blacklist') + blackEntries.map(([k, v]) => t('rejectEntry', k, v.join('/'))).join(t('semiSep')))
            : null,
          el('table', { style: styles.table },
            el('thead', null, el('tr', null,
              el('th', { style: styles.th }, t('model')),
              el('th', { style: styles.th }, t('calls')),
              el('th', { style: styles.th }, t('effortDist')),
              el('th', { style: styles.th }, t('think')),
              el('th', { style: styles.th }, t('output')),
              el('th', { style: styles.th }, t('avgDur')),
              el('th', { style: styles.th }, t('suggestion')),
            )),
            el('tbody', null, modelRows.map(([key, agg], i) => el(TableRow, { key, index: i },
              el('td', { style: styles.td }, key),
              el('td', { style: styles.td }, String(agg.calls)),
              el('td', { style: styles.td }, distChips(agg.efforts)),
              el('td', { style: styles.td }, agg.reasoningTokens > 0 ? String(agg.reasoningTokens) + ' tok' : (agg.reasoningChars > 0 ? '~' + String(agg.reasoningChars) + t('charsUnit') : '—')),
              el('td', { style: styles.td }, String(agg.outputTokens)),
              el('td', { style: styles.td }, avgDuration(agg)),
              el('td', { style: { ...styles.td, color: agg.suggestion ? theme.color.warning : undefined } }, agg.suggestion ?? '—'),
            ))),
          ),
          el('div', { style: styles.subTitle }, t('recentCalls')),
          el('table', { style: styles.table },
            el('thead', null, el('tr', null,
              el('th', { style: styles.th }, t('time')),
              el('th', { style: styles.th }, t('model')),
              el('th', { style: styles.th }, t('effort')),
              el('th', { style: styles.th }, t('think')),
              el('th', { style: styles.th }, t('output')),
              el('th', { style: styles.th }, t('duration')),
              el('th', { style: styles.th }, t('result')),
            )),
            el('tbody', null, (stats.recent ?? []).slice(0, 20).map((r, i) => el(TableRow, { key: i, index: i },
              el('td', { style: styles.td }, fmtTime(r.t)),
              el('td', { style: styles.td }, r.provider + '/' + r.model),
              el('td', { style: styles.td }, r.effort === null ? t('defaultTag') : levelLabel(r.effort)),
              el('td', { style: styles.td }, r.rt !== null ? String(r.rt) + ' tok' : (r.rc !== null ? '~' + String(r.rc) + t('charsUnit') : '—')),
              el('td', { style: styles.td }, r.ot === null ? '—' : String(r.ot)),
              el('td', { style: styles.td }, r.duration === null ? '—' : String(r.duration) + 'ms'),
              el('td', { style: styles.td }, r.finish ?? '—'),
            ))),
          ),
        ),
      )
    }

    // ── 模型级默认编辑器（按各模型实际支持的等级过滤，数据来自 llm.models 实时探测）──
    function ModelDefaults(props) {
      const { api, view, onChange } = props
      const t = props.t || zhT
      const [models, setModels] = useState(null) // [{key, label, efforts: [id...], defaultEffort}]
      const [custom, setCustom] = useState('')

      useEffect(() => {
        // llm.models 一次返回全部 provider 的分组目录（运行时从各 adapter 实时解析）：
        // {groups: [{id, name, models: [{id, name, reasoning?: {efforts: [{id}], defaultEffort?}}]}], failures: []}
        api.llm.models({}).then((response) => {
          if (!response.result.ok) { setModels([]); return }
          const groups = (response.result.value && response.result.value.groups) || []
          const list = []
          const grouped = []
          for (const group of groups) {
            const groupModels = []
            for (const model of group.models ?? []) {
              const reasoning = model.reasoning
              const efforts = reasoning && Array.isArray(reasoning.efforts)
                ? reasoning.efforts.map((e) => e.id).filter((id) => LEVELS.includes(id))
                : []
              const entry = {
                key: group.id + '/' + model.id,
                label: group.id + ' / ' + (model.name || model.id),
                provider: group.id,
                efforts,
                defaultEffort: reasoning && reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : undefined,
              }
              list.push(entry)
              groupModels.push(entry)
            }
            if (groupModels.length > 0) grouped.push({ provider: group.id, models: groupModels })
          }
          setModels({ list, grouped })
        }).catch(() => setModels({ list: [], grouped: [] }))
      }, [])

      const configured = (view.value && view.value.models) || {}
      const entries = Object.entries(configured)
      const modelList = (models && models.list) || []
      const modelGroups = (models && models.grouped) || []
      const byKey = new Map(modelList.map((m) => [m.key, m]))
      // 等级排序权重（档位从低到高）
      const rank = (l) => { const i = LEVELS.indexOf(l); return i < 0 ? -1 : i }
      const highest = (efforts) => efforts.slice().sort((a, b) => rank(b) - rank(a))[0]

      const selected = custom !== '' ? byKey.get(custom) : undefined
      const addEntry = () => {
        if (custom === '') return
        const fallback = selected !== undefined && selected.efforts.length > 0 ? highest(selected.efforts) : 'high'
        onChange({ models: { ...configured, [custom]: fallback } })
        setCustom('')
      }
      const setLevel = (key, level) => {
        const next = { ...configured }
        next[key] = level
        onChange({ models: next })
      }
      const removeEntry = (key) => {
        onChange({ removeModelKey: key })
      }
      const optionLabel = (id) => (LEVEL_LABELS[id] || id) + ' (' + id + ')'
      const modelOptions = modelGroups.map((m) => el('optgroup', { key: 'g_' + m.provider, label: m.provider },
        m.models.map((mm) => el('option', { key: mm.key, value: mm.key },
          mm.label.replace(m.provider + ' / ', '') + (mm.efforts.length > 0 ? '' : t('noLevel'))))))

      const rows = entries.map(([key, level], rowIndex) => {
        const info = byKey.get(key)
        const efforts = info !== undefined && info.efforts.length > 0 ? info.efforts : LEVELS
        const supported = efforts.includes(level)
        const options = efforts.map((item) =>
          el('option', { key: item, value: item }, optionLabel(item)))
        if (!supported) {
          // 已配置等级不在该模型支持列表：保留当前值并明示“运行时将跳过”
          options.push(el('option', { key: '__current', value: level }, optionLabel(level) + t('unsupportedOpt')))
        }
        return el(TableRow, { key, index: rowIndex },
          el('td', { style: styles.td },
            el('div', null, key),
            el('div', { style: styles.cellSub },
              info !== undefined && info.efforts.length > 0
                ? [el('span', { key: '__supports', style: styles.muted }, t('supports'))].concat(
                    efforts.map((item) => el(LevelChip, { key: item, label: levelLabel(item), variant: item === level ? 'primary' : 'neutral' })),
                    supported ? [] : [el(LevelChip, { key: '__current', label: levelLabel(level) + ' ⚠', variant: 'warning' })])
                : el('span', { style: styles.muted }, t('unknown')))),
          el('td', { style: styles.td },
            el('select', {
              value: level,
              onChange: (event) => setLevel(key, event.target.value),
              style: { ...styles.select, ...(!supported ? { color: theme.color.warning } : {}) },
            }, options)),
          el('td', { style: { ...styles.td, whiteSpace: 'nowrap' } },
            el('button', {
              type: 'button',
              onClick: () => removeEntry(key),
              style: btnStyle('danger'),
            }, t('delete'))),
        )
      })

      return el('div', null,
        el('div', { style: styles.row },
          el('span', { style: styles.label }, t('addModel')),
          el('select', {
            value: custom,
            onChange: (event) => setCustom(event.target.value),
            style: { ...styles.select, maxWidth: '340px' },
          },
            el('option', { value: '' }, models === null ? t('loadModels') : t('selectModel')),
            modelOptions),
          el('button', { type: 'button', disabled: custom === '', onClick: addEntry, style: btnStyle('primary') }, t('add')),
          selected !== undefined && selected.efforts.length > 0
            ? el('span', { style: styles.muted }, t('addHint', selected.efforts.join('/'), levelLabel(highest(selected.efforts))))
            : null,
        ),
        entries.length === 0
          ? el('div', { style: styles.hint }, t('noModels'))
          : el('table', { style: styles.table },
              el('thead', null, el('tr', null,
                el('th', { style: styles.th }, t('colModelCap')),
                el('th', { style: styles.th }, t('colDefaultLevel')),
                el('th', { style: styles.th }, t('colActions')),
              )),
              el('tbody', null, rows),
            ),
        el('details', { style: styles.details },
          el('summary', { style: styles.summary }, t('prioritySummary')),
          el('div', { style: styles.hint }, t('modelCapNote'), t('priority'))),
      )
    }

    // ── purpose 级默认（compaction / session-title 独立等级）──────────────
    function PurposeDefaults(props) {
      const { view, onChange } = props
      const t = props.t || zhT
      const purposes = (view.value && view.value.purposes) || {}
      const setPurpose = (key, level) => {
        const next = { ...purposes }
        if (level === 'follow') delete next[key]
        else next[key] = level
        onChange({ purposes: next })
      }
      const row = (key, label) => {
        const current = purposes[key]
        return el('div', { style: styles.row, key },
          el('span', { style: styles.label }, label),
          el('select', {
            value: current !== undefined ? current : 'follow',
            onChange: (event) => setPurpose(key, event.target.value),
            style: styles.select,
          }, ['follow', ...LEVELS].map((item) =>
            el('option', { key: item, value: item }, item === 'follow' ? LEVEL_LABELS.follow : LEVEL_LABELS[item]))),
          current !== undefined
            ? el('span', { style: styles.muted }, t('purposeActive', label))
            : null,
        )
      }
      return el('div', null,
        row('compaction', t('purposeCompaction')),
        row('session-title', t('purposeTitle')),
        el('div', { style: styles.hint }, t('purposeHint')),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function ReasoningPage(props) {
      const api = props.api
      const t = props.t || zhT
      const [view, setView] = useState(null) // llm-reasoning namespace view
      const [summary, setSummary] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [noticeOk, setNoticeOk] = useState(true)

      const refresh = () => {
        api.settings.describe({}).then((response) => {
          if (!response.result.ok) {
            setNotice(t('readFail', (response.result.error && response.result.error.message) || t('unknownErr')))
            setNoticeOk(false)
            return
          }
          const namespaces = (response.result.value && response.result.value.namespaces) || []
          const rl = namespaces.find((entry) => entry.ns === 'llm-reasoning')
          const pi = namespaces.find((entry) => entry.ns === 'llm-pi-ai')
          const ds = namespaces.find((entry) => entry.ns === 'llm-deepseek')
          setView(rl || null)
          let routes = 0
          let models = 0
          const providers = pi && pi.value && pi.value.providers ? pi.value.providers : {}
          for (const profile of Object.values(providers)) {
            if (profile.reasoning !== undefined) routes += 1
            if (Array.isArray(profile.models)) {
              for (const model of profile.models) {
                if (model.reasoningEfforts !== undefined) models += 1
              }
            }
          }
          setSummary({
            routes,
            models,
            deepseek: ds && ds.value ? (ds.value.reasoningEffort === undefined ? null : ds.value.reasoningEffort) : null,
          })
        }).catch(() => { setNotice(t('readStatusFail')); setNoticeOk(false) })
      }

      useEffect(() => { refresh() }, [])

      const change = (patch) => {
        setBusy(true)
        setNotice('')
        // 删除模型级默认：update 是深合并（无法删键），改走 mutate unset
        const call = patch.removeModelKey !== undefined
          ? api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', patch.removeModelKey] }] })
          : api.settings.update({ ns: 'llm-reasoning', patch })
        call.then((response) => {
          if (!response.result.ok) {
            setNotice(t('saveFail', (response.result.error && response.result.error.message) || t('unknownErr')))
            setNoticeOk(false)
          } else {
            refresh()
            setNotice(t('savedNotice'))
            setNoticeOk(true)
          }
        }).catch(() => { setNotice(t('saveFailShort')); setNoticeOk(false) }).then(() => setBusy(false))
      }

      if (view === null) {
        return el('div', { style: styles.loading }, t('loading'))
      }

      const value = view.value || {}
      const enabled = value.enabled !== false
      const level = LEVELS.includes(value.level) ? value.level : 'high'
      const deepseekText = summary === null || summary.deepseek === null
        ? t('dsUnset')
        : t('dsSet', levelLabel(summary.deepseek))

      return el('div', { style: styles.page },
        el(Card, { title: t('globalSettings') },
          el('label', { style: styles.row },
            el('span', { style: styles.label }, t('enable')),
            el('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: busy,
              onChange: (event) => change({ enabled: event.target.checked }),
            }),
          ),
          el('div', { style: styles.row },
            el('span', { style: styles.label }, t('level')),
            el('select', {
              value: level,
              disabled: busy || !enabled,
              onChange: (event) => change({ level: event.target.value }),
              style: styles.select,
            }, LEVELS.map((item) => el('option', { key: item, value: item }, LEVEL_LABELS[item]))),
          ),
          el('label', { style: styles.row },
            el('span', { style: styles.label }, t('syncAgent')),
            el('input', {
              type: 'checkbox',
              checked: value.syncDefaultAgent === true,
              disabled: busy || !enabled,
              onChange: (event) => change({ syncDefaultAgent: event.target.checked }),
            }),
          ),
          el('div', { style: styles.status },
            summary === null
              ? t('summarizing')
              : t('appliedSummary', String(summary.routes), String(summary.models), deepseekText),
          ),
          notice !== '' ? el('div', { style: { ...styles.status, color: noticeOk ? theme.color.success : theme.color.danger } }, notice) : null,
        ),
        el(Card, { title: t('modelDefaults') },
          el(ModelDefaults, { api, view, onChange: change, t })),
        el(Card, { title: t('purposeLevels') },
          el(PurposeDefaults, { view, onChange: change, t })),
        el(StatsPanel, { api, t }),
        el('details', { style: styles.details },
          el('summary', { style: styles.summary }, t('hintSummary')),
          el('div', { style: styles.hint },
            t('pageHintMain'),
            t('pageHintRoute'),
            t('statsHint'),
          ),
        ),
      )
    }

    // ── MAINT-022：宿主客户端面适配（DSH 0.1.1-rc.x → 0.1.2-rc.1）────────────
    // 用户报障（2026-09-05，截图 sha256:f3515191）：设置 → 统一推理等级内容区
    // 整页空白（导航项在）。RCA（宿主源码实证 + 同源先例 dsh-agent-router
    // FIX-028 f0438f9 用户复验通过）：
    //  · dsh-client-connection 0.1.2-rc.1 lib/client.js:4754-4825 的 connection
    //    handle 仅 isLoopback/generation/state/rpc/reconnect/
    //    registerGenerationSource/start——`api` 字段已移除；旧实现
    //    `const api = ctx.get('connection').api` → undefined → ReasoningPage
    //    首次数据调用同步抛 TypeError → dsh-client-ui-renderer SlotErrorBoundary
    //    捕获（渲染空 div + 条目退位）→ 内容区空白。
    //  · 新面 = dsh-api-remotes typed remote 命名空间：remote.settings
    //    （describe/mutate/replace/update——api-remotes lib/client.js:5051/
    //    5069/5166/5216，位置参数 + {ok, value|error} 直面）+
    //    remote.session.modelCatalog（:8267——ModelCatalog.groups 形状与旧
    //    api.llm.models 的 groups 一致）。官方消费先例：
    //    dsh-client-ui-settings-models 静态 inject remote.credentials/llm/settings。
    // 本适配层把新面收敛成页面既有消费面（旧信封 {result:{ok,value?,error?}}），
    // 页面/组件消费点零改动；调用时惰性解析 ctx.get('remote.*')（服务重挂后取
    // 最新，不缓存旧引用）；命名空间缺失 = 宿主版本不兼容 → fail-loud（结构化
    // 错误进页面「读取失败」行，禁裸 TypeError 击穿面板——P8，先例 FIX-028）。
    function hostApiFace(ctx) {
      const faceOf = (name) => {
        const viaGet = ctx.get('remote.' + name)
        return viaGet !== undefined ? viaGet : (ctx.remote ? ctx.remote[name] : undefined)
      }
      const unavailable = (name) => {
        throw new Error(`dsh-reasoning-level: host remote face "${name}" 不可用——宿主 remote.${name} 命名空间未挂载或插件版本与宿主不兼容`)
      }
      const envelopeOf = (response) => {
        if (response && typeof response === 'object' && typeof response.ok === 'boolean') {
          return {
            result: {
              ok: response.ok,
              ...(response.ok
                ? { value: response.value }
                : { error: response.error && response.error.message ? response.error : { message: String(response.error ?? response) } }),
            },
          }
        }
        return { result: { ok: false, error: { message: `dsh-reasoning-level: host remote answered ${String(response)}` } } }
      }
      const requireSettings = () => {
        const settings = faceOf('settings')
        if (!settings || typeof settings.describe !== 'function' || typeof settings.update !== 'function' || typeof settings.mutate !== 'function') unavailable('settings')
        return settings
      }
      const requireSession = () => {
        const session = faceOf('session')
        if (!session || typeof session.modelCatalog !== 'function') unavailable('session')
        return session
      }
      return {
        settings: {
          describe: async () => envelopeOf(await requireSettings().describe()),
          update: async (payload) => {
            const input = payload && typeof payload === 'object' ? payload : {}
            return envelopeOf(await requireSettings().update(input.ns, input.patch))
          },
          mutate: async (payload) => {
            const input = payload && typeof payload === 'object' ? payload : {}
            return envelopeOf(await requireSettings().mutate(input.ns, Array.isArray(input.ops) ? input.ops : []))
          },
        },
        llm: {
          models: async () => {
            const catalog = await requireSession().modelCatalog()
            if (!catalog || typeof catalog !== 'object' || typeof catalog.ok !== 'boolean') {
              return { result: { ok: false, error: { message: 'dsh-reasoning-level: session.modelCatalog 直面响应形状不符' } } }
            }
            if (!catalog.ok) return envelopeOf(catalog)
            const value = catalog.value ?? {}
            return { result: { ok: true, value: { groups: Array.isArray(value.groups) ? value.groups : [], failures: Array.isArray(value.failures) ? value.failures : [] } } }
          },
        },
      }
    }

    const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.session']

    function apply(ctx) {
      // MAINT-022：宿主 0.1.2-rc.1 起 connection.api 已移除——统一经 remote.*
      // 命名空间适配（hostApiFace 单点）。旧实现 `ctx.get('connection').api`
      // 升级后恒 undefined（页面加载失败，用户截图实证），已删除（P5：被取代
      // 路径禁止并存）。inject 声明同时拿到两点保证：runner 激活门控等待
      // 命名空间就绪（页面永不早于宿主面加载）、属性面可见（官方先例
      // dsh-client-ui-settings-models 静态 inject）。
      const api = hostApiFace(ctx)
      const locale = ctx.get('locale')
      let localeValue = 'zh'
      if (locale !== undefined && typeof locale.getSnapshot === 'function') {
        try {
          const snap = locale.getSnapshot()
          if (snap !== undefined && snap.active !== undefined) localeValue = snap.active
        } catch (error) { /* 快照读取失败回退 zh */ }
      }
      const t = makeT(localeValue)
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'reasoning-level', order: 12, label: () => t('title') || '统一推理等级' },
        (props) => el(ReasoningPage, { api: props.api !== undefined ? props.api : api, t: props.t !== undefined ? props.t : t }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
