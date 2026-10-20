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
 * 渲染层（UX-003 §2）：内联样式迁到注入式 STYLESHEET（.rl-* + `.rl-root` 令牌）。
 * 全部颜色为半透明灰阶 + currentColor + 语义色半透明变体——不读取宿主主题 API
 * （无文档保证，见执行包 assumption_record）；ensureStyles 在无 document 环境静默
 * 跳过，组件仍渲染完整节点树（冒烟 vm 沙箱的硬约束）。
 *
 * 页面骨架（UX-003 §3.1-3.3）：PageHeader + Overview + 全局卡（含影响预览），
 * 模型级/辅助调用/观测卡沿用既有实现（模型目录上提到页面共享）。
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
    // ── 等级语义（规范 §4.1）───────────────────────────────────────────────
    // 档名 / 含义（≤8 字，作分段控件副标）/ 适用场景（hover title）三件套双语。
    // `follow` 只是“不设置”的下拉哨兵，不属于 7 个真实档位，故不进 LEVEL_HINTS。
    const LEVEL_LABELS = {
      zh: { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', follow: '跟随全局' },
      en: { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max', follow: 'Follow global' },
    }
    const LEVEL_HINTS = {
      off: {
        zh: { name: '关闭', meaning: '不思考', scenario: '机械改写/格式化/JSON 修补，追求最快最省（注意：部分网关即使收到 disabled 仍可能计费思考）' },
        en: { name: 'Off', meaning: 'No thinking', scenario: 'Mechanical rewrites, formatting, JSON fixes — fastest and cheapest (note: some gateways may still bill thinking even when disabled is sent)' },
      },
      minimal: {
        zh: { name: '极低', meaning: '一笔带过', scenario: '简单问答、单轮事实查询' },
        en: { name: 'Minimal', meaning: 'Brief', scenario: 'Simple Q&A, single-turn factual lookups' },
      },
      low: {
        zh: { name: '低', meaning: '轻量推理', scenario: '摘要、抽取、简单代码补全' },
        en: { name: 'Low', meaning: 'Light', scenario: 'Summaries, extraction, simple code completion' },
      },
      medium: {
        zh: { name: '中', meaning: '常规推理', scenario: '日常编码、多步指令' },
        en: { name: 'Medium', meaning: 'Standard', scenario: 'Everyday coding, multi-step instructions' },
      },
      high: {
        zh: { name: '高', meaning: '深度推理（默认）', scenario: '复杂重构、方案设计' },
        en: { name: 'High', meaning: 'Deep', scenario: 'Complex refactors, solution design' },
      },
      xhigh: {
        zh: { name: '极高', meaning: '更深推理', scenario: '长链路调试、疑难定位（非所有模型支持）' },
        en: { name: 'X-High', meaning: 'Deeper', scenario: 'Long debugging chains, hard diagnosis (not all models support it)' },
      },
      max: {
        zh: { name: '最大', meaning: '最深推理', scenario: '难题攻坚；最慢最贵（实测支持才可选）' },
        en: { name: 'Max', meaning: 'Deepest', scenario: 'Hardest problems; slowest and priciest (only selectable when measured as supported)' },
      },
    }
    // 语言一律由 t 携带（makeT 注入 lang），组件不再额外依赖宿主 locale——
    // 页面可通过 props.t 被宿主重挂，字典必须与传入的 t 同源。
    const langOf = (t) => (t !== undefined && t !== null && t.lang === 'en' ? 'en' : 'zh')
    /** 等级展示的唯一入口（规范 §4.1：分段控件/下拉/chips/表格/建议/CSV 全走这里）。 */
    const levelLabel = (level, lang) => {
      const dict = LEVEL_LABELS[lang === 'en' ? 'en' : 'zh']
      return dict[level] || level
    }
    const levelHint = (level, lang) => {
      const entry = LEVEL_HINTS[level]
      return entry !== undefined ? entry[lang === 'en' ? 'en' : 'zh'] : undefined
    }
    /**
     * efforts / byLevel / CSV 的「桶键」展示（R0-P2-4）：wire 键 `(默认)` 保持不变，
     * 只在渲染层按当前语言映射为 t('defaultTag')（zh `(默认)` / en `(default)`）；
     * 其余键仍走 levelLabel（含未知自定义档原样显示）。
     */
    const DEFAULT_EFFORT_KEY = '(默认)'
    const effortLabel = (key, lang, t) => (key === DEFAULT_EFFORT_KEY ? t('defaultTag') : levelLabel(key, lang))

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
        statsHint: '统计中的“推理等级”按插件入口记录：有值 = 会话/模型默认注入的显式等级；(默认) = 该次调用入口未显式指定——实际请求会由宿主适配器物化所在路由的默认等级（(默认→高) 即路由默认为“高”；路由无默认或不被模型支持时不标注）。',
        testingNote: '一键探测会对每个模型发 1-token 实测请求验证全部候选等级，结束后把可用等级固化进模型能力声明；不同模型可独立使用实际支持的等级。导出可下载 CSV。',
        model: '模型', calls: '调用', effortDist: '等级分布', think: '思考', output: '输出', avgDur: '平均耗时', suggestion: '建议',
        thinkTokens: '思考tokens', thinkChars: '思考字符', outputTokens: '输出tokens', avgDurMs: '平均耗时ms', errRateCol: '错误率%',
        time: '时间', effort: '推理等级', duration: '耗时', result: '结果',
        blacklist: '⚠ 实测黑名单：', since: '自', totalCalls: '共', callsSuffix: '次调用（每 2s 刷新）',
        hostContractWarn: (m) => `⚠ 宿主契约不兼容：插件功能已降级（缺失：${m}）。请确认宿主 dsh ≥0.2.0-rc.2 且插件版本匹配——宿主本身不受影响。`,
        rejectEntry: (k, v) => `${k} 拒绝 ${v}`,
        semiSep: '；',
        errHigh: (n) => `错误率 ${n}% 偏高，建议降低等级`,
        rejectSug: (rej, hi) => `实测拒绝 ${rej.join('/')}，建议用最高档 ${hi ?? '（默认）'}`,
        supports: '支持：', unknown: '能力未知', noLevel: '（无推理等级）',
        defaultTag: '(默认)', defaultedTag: (l) => `(默认→${l})`, charsUnit: ' 字',
        testOk: (t, l, d) => `✓ ${t} · ${l} 可用（${d}ms）`,
        testFail: (t, l, e) => `✗ ${t} · ${l} 不可用${e ? '：' + e : ''}`,
        blacklisted: '（已入黑名单）',
        probeAll: '一键探测全部模型并固化配置',
        probing: (i, n, k) => `探测中 ${i}/${n}：${k}`,
        probeDone: (n, w, a, official, other, nw) => {
          const parts = [`探测完成：${n} 个模型，固化 ${w} 处模型能力声明`]
          if (a !== '0') parts.push(`${a} 个已与实测一致（无需改动）`)
          // R0-P2-1（设计 §10.1）：三种「未写入」结局分别计数、各给一句准确文案，
          // 不再复用一个「不在 llm-pi-ai 配置」断言（官方适配器模型此前被错算进该桶）。
          if (official !== '0') parts.push(`${official} 个由官方适配器管理（无需写入）`)
          if (other !== '0') parts.push(`${other} 个由其他适配器提供（无需写入）`)
          if (nw !== '0') parts.push(`${nw} 个暂无可固化等级`)
          parts.push('实测拒绝的等级仅作为该次探测结果（不入黑名单），运行时自愈（真实调用失败会临时跳过该档，重启即清零）')
          return parts.join('；')
        },
        probeRestored: (time) => `已载入上次探测结果（${time} · 持久化回显）`,
        neverProbed: '尚未探测过——探测结果会持久保存，刷新或重启后仍在此显示。',
        probeColPersisted: '持久化',
        persistedConverged: '已固化（探测收敛）',
        persistedWritten: '已固化',
        persistedNoChange: '已与实测一致（无需改动）',
        persistedPending: '待固化（声明与实测不一致）',
        persistedNotInConfig: '不在 llm-pi-ai 配置——仅展示，未写入',
        // FEAT-004（设计 §10.1 第三态）：同一个 skipped:not-in-pi-ai-config 结局要按
        // provider 是否已配置分流——「provider 在、模型没列」与「provider 归其他适配器管」
        // 对应完全不同的下一步，不能共用一句「不在配置」。
        persistedNotInConfigModel: (provider) => `在 llm-pi-ai 的 ${provider} 下没有这个模型——添加该模型后即可固化`,
        persistedOtherAdapter: '该模型由其他适配器提供（不在 llm-pi-ai 配置中）——等级由提供方控制，无需在此固化',
        persistedOfficialAdapter: '由 DeepSeek 官方适配器管理——等级经官方通道下发，无需写入模型能力声明',
        persistedNoWorking: '无可固化等级',
        persistedError: '固化失败',
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
        appliedSummary: (r, m, d) => `已应用：${r} / ${m} 个模型 · DeepSeek 官方：${d}`,
        zeroRoutes: '无路由默认',
        routeItem: (name, level) => `${name}=${level}`,
        routeItemMismatch: (name, level, global) => `${name}=${level}（≠全局${global}）`,
        dsUnset: '未设置（保持原状）',
        dsSet: (l) => `设置为 ${l}`,
        pageHintMain: '说明：全局默认动态生效——修改后下一次模型请求即采用新等级。手写声明的模型自动补齐「推理等级」能力（含最大 Max）；',
        pageHintRoute: '每条路由只有在全部模型都支持该等级时才写入默认值。',
        // ── UX-003 §4.2：页面骨架与后续批次共用的新增 key（zh/en 必须成对）─────
        pageSubtitle: '一个开关管理所有模型的默认思考强度',
        statusEnabled: '启用中',
        statusDisabled: '已停用',
        statusDegraded: '功能降级',
        statusDefault: (level) => `默认：${level}`,
        statusScope: (routes, models) => `生效 ${routes} 路由 · ${models} 模型`,
        scopeValue: (routes, models) => `${routes} 路由 · ${models} 模型`,
        tileLevel: '当前默认等级',
        tileScope: '生效范围',
        tileCalls: '调用总量',
        tileThinking: '思考量',
        tileThinkingUnknown: '不可观测',
        tileThinkingCoverage: (n, total) => `${n} / ${total} 模型回报 reasoningTokens`,
        tileCallsSince: (time) => `自 ${time} 起`,
        scopePending: (n) => `${n} 路由待同步`,
        levelMeaning: '含义',
        levelScenario: '适用场景',
        // R0-P2-5（设计 §10.2）：选中 off 时可见的一句计费边界说明（不只藏在 hover title）。
        offBillingNote: '注意：部分网关即使收到 disabled 仍可能计费思考——off 只是请求不思考，不代表网关一定不计费。',
        impactPreview: (level, n) => `影响预览：${n} 个模型支持「${level}」`,
        impactSkip: (n, names) => `${n} 个将跳过${names ? '（' + names + ' …）' : ''}`,
        impactUnknown: (n) => `${n} 个能力未知`,
        switchOnHint: '新调用将使用默认等级',
        // R0-P2-6：如实描述实际还原面——disabled 分支只还原 llm-pi-ai / llm-deepseek，
        // agent-default-model.reasoningEffort 没有反向写路径（不得声称已全部还原）。
        switchOffHint: '本插件写入的模型能力声明与 DeepSeek 路由配置已还原（默认 agent 模型不自动还原）',
        // R0-P2-6：syncDefaultAgent 只在开启且等级变化时单向写入，从无还原路径。
        syncAgentHint: '开启后全局等级变化会同步写入 agent-default-model.reasoningEffort；关闭后不再同步，已写入的值保持不变',
        searchModel: '搜索模型（provider/model）',
        searchEmpty: '没有匹配的模型',
        searchExactKey: '输入完整 provider/model 键可直接添加',
        supportMatrix: '支持矩阵',
        supportMatrixSummary: (n, probed, total) => `${n} 个模型 · 覆盖率 ${probed}/${total} 已探测`,
        supportYes: '支持',
        supportNo: '不支持',
        supportUnknown: '未知',
        // 支持矩阵单元格 title 的来源标注（设计 §3.4.3：实测 / 目录声明）
        supportSourceMeasured: '实测',
        supportSourceCatalog: '目录声明',
        supportSourceRejected: '实测拒绝',
        probeThisModel: '探测此模型',
        pauseRefresh: '暂停刷新',
        resumeRefresh: '继续刷新',
        onlyIssues: '只看异常',
        statsToolbarMeta: '每 2s 刷新 · 最近 100 条',
        noIssuesFound: '没有异常调用',
        sortBy: '排序',
        ariaSortAsc: '升序',
        ariaSortDesc: '降序',
        thinkingApprox: '思考字符近似（网关未回报 reasoning tokens）',
        // R0-P2-5（设计 §10.2）：rt 与 rc 都为 0/缺席时的 title——「网关未回报」而非「无思考」。
        thinkingUnreported: '该网关未回报 reasoning tokens',
        suggestionApply: (level) => `建议用最高档 ${level}`,
        levelCompare: '等级对比（同一模型不同等级的实际代价）',
        levelCompareEmpty: '等级对比数据自 v0.9.0 起累积——历史调用没有按等级拆分记录，跑几轮不同等级的调用后这里会出现对照。',
        // R0-P3-6：byLevel 为空但 efforts 里有非受控档键（被 wire 受控键过滤）——
        // 这是「档位不标准」而非「历史缺失」，不得复用上面的累积空态文案。
        levelCompareNonStandard: '该模型的调用使用了非标准档位（如自定义 effort），未计入等级对比。',
        levelCompareCalls: '调用',
        levelCompareDuration: '平均耗时',
        levelCompareOutput: '平均输出 tok',
        levelCompareThinking: '平均思考 tok',
        probeReasonAuth: '凭据或鉴权失败——请检查该 provider 的密钥',
        probeReasonNotFound: '模型在该 provider 不存在或已下线',
        probeReasonRate: '限流或额度不足——稍后重试',
        probeReasonTimeout: '探测超时（30s）——网关无响应',
        probeReasonUnknown: '未知原因',
        undoSucceeded: '已撤销',
        // R0-P2-3：撤销时该键已被他人重新添加——本次写入直接覆盖为新值（只动这一个键）。
        undoRestoredOverride: '已撤销（该模型已被重新添加，等级已覆盖为原值）',
        undoAction: '撤销',
        revertedNotice: '已还原为修改前的值',
        saveFailedReverted: (m) => `保存失败，已回滚：${m}`,
        skipRuntime: '运行时跳过',
        notProbed: '能力未知 · 未探测',
        coverage: '覆盖率',
        recentAll: '全部',
        recentErrorsOnly: '仅错误',
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
        statsHint: 'The “level” in stats is captured at the plugin hook entry: a value = explicit level (session selection or injected default); (default) = no explicit level at the entry — the actual request is materialized by the host adapter with the route\u2019s default level ((default→High) marks that route default; unannotated when the route has none or it is unsupported).',
        testingNote: 'Probe-all sends a 1-token request per candidate level, then writes working levels back to capability declarations; different models may support different levels natively. Export downloads CSV.',
        model: 'Model', calls: 'Calls', effortDist: 'Effort dist', think: 'Think', output: 'Output', avgDur: 'Avg dur', suggestion: 'Suggestion',
        thinkTokens: 'Think tokens', thinkChars: 'Think chars', outputTokens: 'Output tokens', avgDurMs: 'Avg duration ms', errRateCol: 'Error rate%',
        time: 'Time', effort: 'Effort', duration: 'Duration', result: 'Result',
        blacklist: '⚠ Blacklist: ', since: 'Since', totalCalls: 'total', callsSuffix: 'calls (2s refresh)',
        hostContractWarn: (m) => `⚠ Host contract mismatch: plugin features degraded (missing: ${m}). Ensure dsh ≥0.2.0-rc.2 and a matching plugin version — the host itself is unaffected.`,
        rejectEntry: (k, v) => `${k} rejected ${v}`,
        semiSep: '; ',
        errHigh: (n) => `Error rate ${n}% high, consider lowering level`,
        rejectSug: (rej, hi) => `Rejected ${rej.join('/')} in practice, use highest ${hi ?? '(default)'}`,
        supports: 'Supports: ', unknown: 'capability unknown', noLevel: '(no reasoning level)',
        defaultTag: '(default)', defaultedTag: (l) => `(default→${l})`, charsUnit: ' chars',
        testOk: (t, l, d) => `✓ ${t} · ${l} OK (${d}ms)`,
        testFail: (t, l, e) => `✗ ${t} · ${l} failed${e ? ': ' + e : ''}`,
        blacklisted: ' (blacklisted)',
        probeAll: 'Probe all models & fix config',
        probing: (i, n, k) => `Probing ${i}/${n}: ${k}`,
        probeDone: (n, w, a, official, other, nw) => {
          const parts = [`Probe complete: ${n} models, ${w} capability declarations updated`]
          if (a !== '0') parts.push(`${a} already match measurement (no change needed)`)
          if (official !== '0') parts.push(`${official} managed by the official adapter (no write needed)`)
          if (other !== '0') parts.push(`${other} provided by other adapters (no write needed)`)
          if (nw !== '0') parts.push(`${nw} have no level to persist yet`)
          parts.push('rejected levels are probe-only (not blacklisted), runtime self-healing (real failures skip the level for this session, resets on restart)')
          return parts.join('; ')
        },
        probeRestored: (time) => `Loaded last probe results (${time} · persisted)`,
        neverProbed: 'Never probed — probe results are persisted and survive refresh/restart.',
        probeColPersisted: 'Persisted',
        persistedConverged: 'persisted (converged at probe)',
        persistedWritten: 'persisted',
        persistedNoChange: 'already matches measurement (no change needed)',
        persistedPending: 'pending apply (declaration ≠ measurement)',
        persistedNotInConfig: 'not in llm-pi-ai config — display only, not written',
        persistedNotInConfigModel: (provider) => `This model is not listed under ${provider} in llm-pi-ai — add it there, then probe to persist`,
        persistedOtherAdapter: 'Provided by another adapter (not in llm-pi-ai config) — its level is controlled by that provider, nothing to persist here',
        persistedOfficialAdapter: 'Managed by the official DeepSeek adapter — the level is delivered through the official channel; no model capability declaration needed',
        persistedNoWorking: 'no working levels to persist',
        persistedError: 'persist failed',
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
        appliedSummary: (r, m, d) => `Applied: ${r} / ${m} models · DeepSeek official: ${d}`,
        zeroRoutes: 'no route defaults',
        routeItem: (name, level) => `${name}=${level}`,
        routeItemMismatch: (name, level, global) => `${name}=${level} (≠ global ${global})`,
        dsUnset: 'not set (unchanged)',
        dsSet: (l) => `set to ${l}`,
        pageHintMain: 'Notes: the global default applies dynamically — the next model request uses the new level. Hand-written model declarations get reasoning levels auto-filled (including Max). ',
        pageHintRoute: 'A route only gets a default level when every model on it supports that level. ',
        // ── UX-003 §4.2：页面骨架与后续批次共用的新增 key（zh/en 必须成对）─────
        pageSubtitle: 'One switch controls the default thinking depth for every model',
        statusEnabled: 'Enabled',
        statusDisabled: 'Disabled',
        statusDegraded: 'Degraded',
        statusDefault: (level) => `Default: ${level}`,
        statusScope: (routes, models) => `${routes} routes · ${models} models`,
        scopeValue: (routes, models) => `${routes} routes · ${models} models`,
        tileLevel: 'Current default',
        tileScope: 'Effective scope',
        tileCalls: 'Total calls',
        tileThinking: 'Thinking volume',
        tileThinkingUnknown: 'Not observable',
        tileThinkingCoverage: (n, total) => `${n} / ${total} models report reasoningTokens`,
        tileCallsSince: (time) => `since ${time}`,
        scopePending: (n) => `${n} route(s) pending sync`,
        levelMeaning: 'Meaning',
        levelScenario: 'Use when',
        offBillingNote: 'Note: some gateways may still bill thinking even when disabled is sent — off requests no thinking, but billing is up to the gateway.',
        impactPreview: (level, n) => `Impact: ${n} models support “${level}”`,
        impactSkip: (n, names) => `${n} will be skipped${names ? ' (' + names + ' …)' : ''}`,
        impactUnknown: (n) => `${n} capability unknown`,
        switchOnHint: 'New calls use the default level',
        switchOffHint: 'Model capability declarations and the DeepSeek route config written by this plugin have been reverted (the default agent model is not reverted automatically)',
        syncAgentHint: 'When on, global level changes are written to agent-default-model.reasoningEffort; when off, syncing stops and values already written stay unchanged',
        searchModel: 'Search models (provider/model)',
        searchEmpty: 'No matching models',
        searchExactKey: 'Type a full provider/model key to add it directly',
        supportMatrix: 'Support matrix',
        supportMatrixSummary: (n, probed, total) => `${n} models · coverage ${probed}/${total} probed`,
        supportYes: 'Yes',
        supportNo: 'No',
        supportUnknown: 'Unknown',
        supportSourceMeasured: 'measured',
        supportSourceCatalog: 'declared by catalog',
        supportSourceRejected: 'measured rejection',
        probeThisModel: 'Probe this model',
        pauseRefresh: 'Pause refresh',
        resumeRefresh: 'Resume refresh',
        onlyIssues: 'Issues only',
        statsToolbarMeta: 'Refresh every 2s · last 100',
        noIssuesFound: 'No problematic calls',
        sortBy: 'Sort',
        ariaSortAsc: 'ascending',
        ariaSortDesc: 'descending',
        thinkingApprox: 'Approximate thinking chars (gateway does not report reasoning tokens)',
        thinkingUnreported: 'This gateway did not report reasoning tokens',
        suggestionApply: (level) => `Use highest: ${level}`,
        levelCompare: 'Level comparison (actual cost per level for the same model)',
        levelCompareEmpty: 'Level comparison data accumulates from v0.9.0 on — earlier calls were not split by level. Run a few calls at different levels to see a comparison here.',
        levelCompareNonStandard: 'This model\u2019s calls used non-standard levels (e.g. custom effort) and are not included in the level comparison.',
        levelCompareCalls: 'Calls',
        levelCompareDuration: 'Avg duration',
        levelCompareOutput: 'Avg output tok',
        levelCompareThinking: 'Avg thinking tok',
        probeReasonAuth: 'Credentials or auth failed — check the provider key',
        probeReasonNotFound: 'Model does not exist on this provider or is retired',
        probeReasonRate: 'Rate limited or quota exhausted — retry later',
        probeReasonTimeout: 'Probe timed out (30s) — gateway did not respond',
        probeReasonUnknown: 'Unknown reason',
        undoSucceeded: 'Undone',
        undoRestoredOverride: 'Undone (the model was re-added meanwhile; its level was overwritten with the old value)',
        undoAction: 'Undo',
        revertedNotice: 'Reverted to the previous value',
        saveFailedReverted: (m) => `Save failed, reverted: ${m}`,
        skipRuntime: 'skipped at runtime',
        notProbed: 'capability unknown · not probed',
        coverage: 'coverage',
        recentAll: 'All',
        recentErrorsOnly: 'Errors only',
      },
    }
    function makeT(locale) {
      const lang = locale === 'en' ? 'en' : 'zh'
      // 缺 key 回退 zh 而不是 undefined：旧服务端/旧宿主的降级路径里，宁可显示
      // 中文也不要把 `undefined` 直接渲染成空节点。
      const dict = LANG[lang]
      const t = (key, ...args) => {
        const v = dict[key] !== undefined ? dict[key] : LANG.zh[key]
        return typeof v === 'function' ? v(...args) : v
      }
      t.lang = lang
      return t
    }
    const zhT = makeT('zh')

    // ── 样式体系（规范 §2）：注入式样式表取代内联样式 ─────────────────────
    // 内联样式无法表达 :hover/:focus-visible/media query，导致 UX-001 只能用受控
    // state 模拟 hover（抖动）且键盘不可见。这里把全部规则收进一个 <style>，
    // 组件只挂 className；唯一的 inline style 留给运行期才确定的数值（进度条宽
    // 度等），静态视觉一律走 CSS。
    const STYLE_ID = 'dsh-reasoning-level-styles'
    const STYLESHEET = `
.rl-root {
  --rl-fg: currentColor;
  --rl-muted: 0.62;
  --rl-line: rgba(128,128,128,.28);
  --rl-line-strong: rgba(128,128,128,.45);
  --rl-surface: rgba(128,128,128,.07);
  --rl-surface-2: rgba(128,128,128,.11);
  --rl-hover: rgba(128,128,128,.14);
  --rl-accent: rgba(25,118,210,.72);
  --rl-accent-soft: rgba(25,118,210,.14);
  --rl-ok: rgba(46,125,50,.95);
  --rl-ok-soft: rgba(76,175,80,.18);
  --rl-warn: rgba(178,106,0,.95);
  --rl-warn-soft: rgba(255,167,38,.2);
  --rl-bad: rgba(198,40,40,.95);
  --rl-bad-soft: rgba(229,57,53,.16);
  --rl-r-card: 12px; --rl-r-ctl: 8px; --rl-r-chip: 999px;
  --rl-s1: 4px; --rl-s2: 8px; --rl-s3: 12px; --rl-s4: 16px; --rl-s5: 24px; --rl-s6: 32px;
  --rl-f-xs: 11px; --rl-f-sm: 12px; --rl-f-md: 13px; --rl-f-lg: 15px; --rl-f-xl: 20px;
  --rl-t: 140ms cubic-bezier(.2,.7,.3,1);
  color: var(--rl-fg);
  font-size: var(--rl-f-md);
  line-height: 1.5;
}
.rl-root *, .rl-root *::before, .rl-root *::after { box-sizing: border-box }
.rl-root :focus-visible { outline: 2px solid var(--rl-accent); outline-offset: 2px; border-radius: inherit }
.rl-page { display: flex; flex-direction: column; gap: var(--rl-s4); padding: var(--rl-s2) 0 var(--rl-s6) }
.rl-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--rl-s4) }
.rl-split { display: grid; grid-template-columns: 1.6fr 1fr; gap: var(--rl-s4); align-items: start }
.rl-header { display: flex; flex-direction: column; gap: var(--rl-s3); padding: var(--rl-s2) 0 var(--rl-s1) }
.rl-header-main { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--rl-s4); flex-wrap: wrap }
.rl-header-title { margin: 0; font-size: var(--rl-f-xl); font-weight: 600; letter-spacing: .2px }
.rl-header-sub { margin: var(--rl-s1) 0 0; font-size: var(--rl-f-sm); opacity: var(--rl-muted) }
.rl-header-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--rl-s1) }
.rl-progress-text { font-size: var(--rl-f-xs); opacity: var(--rl-muted); max-width: 320px; text-align: right }
.rl-pills { display: flex; flex-wrap: wrap; gap: var(--rl-s2); align-items: center }
.rl-card { background: var(--rl-surface); border: 1px solid var(--rl-line); border-radius: var(--rl-r-card); padding: var(--rl-s4) }
.rl-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--rl-s3); margin-bottom: var(--rl-s3) }
.rl-card-head-main { display: flex; gap: var(--rl-s2); align-items: flex-start; min-width: 0 }
.rl-card-accent { width: 3px; height: 16px; border-radius: 2px; background: var(--rl-accent); margin-top: 2px; flex: 0 0 auto }
.rl-card-title { margin: 0; font-size: var(--rl-f-lg); font-weight: 600 }
.rl-card-sub { margin: 2px 0 0; font-size: var(--rl-f-sm); opacity: var(--rl-muted) }
.rl-card-actions { display: flex; gap: var(--rl-s2); align-items: center; flex-wrap: wrap }
.rl-stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--rl-s3) }
.rl-stat { background: var(--rl-surface); border: 1px solid var(--rl-line); border-radius: var(--rl-r-card); padding: var(--rl-s3) var(--rl-s4); min-height: 84px; transition: background-color var(--rl-t), border-color var(--rl-t), opacity var(--rl-t) }
.rl-stat:hover { background: var(--rl-surface-2) }
.rl-stat-label { font-size: var(--rl-f-xs); opacity: var(--rl-muted); letter-spacing: .04em }
.rl-stat-value { font-size: var(--rl-f-xl); font-weight: 600; margin-top: var(--rl-s1); line-height: 1.25; overflow-wrap: anywhere }
.rl-stat-sub { font-size: var(--rl-f-xs); opacity: var(--rl-muted); margin-top: var(--rl-s1); line-height: 1.5 }
.rl-stat-sub-warn { color: var(--rl-warn); opacity: 1 }
.rl-scale { display: flex; gap: 3px; margin-top: var(--rl-s2); align-items: center }
.rl-scale-seg { height: 4px; flex: 1; border-radius: 2px; background: var(--rl-surface-2) }
.rl-scale-seg-on { background: var(--rl-accent) }
.rl-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: var(--rl-r-chip); border: 1px solid var(--rl-line); background: var(--rl-surface); font-size: var(--rl-f-xs); white-space: nowrap }
.rl-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .85 }
.rl-pill-ok { color: var(--rl-ok); background: var(--rl-ok-soft); border-color: var(--rl-ok-soft) }
.rl-pill-bad { color: var(--rl-bad); background: var(--rl-bad-soft); border-color: var(--rl-bad-soft) }
.rl-pill-warn { color: var(--rl-warn); background: var(--rl-warn-soft); border-color: var(--rl-warn-soft) }
.rl-pill-primary { color: var(--rl-accent); background: var(--rl-accent-soft); border-color: var(--rl-accent-soft) }
.rl-pill-muted { opacity: .8 }
.rl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 14px; border-radius: var(--rl-r-ctl); border: 1px solid var(--rl-line-strong); background: transparent; color: inherit; font: inherit; font-size: var(--rl-f-sm); line-height: 1.4; cursor: pointer; transition: background-color var(--rl-t), border-color var(--rl-t), opacity var(--rl-t) }
.rl-btn:hover:not(:disabled) { background: var(--rl-hover) }
.rl-btn:disabled { opacity: .45; cursor: not-allowed }
.rl-btn-sm { padding: 3px 10px; font-size: var(--rl-f-xs) }
.rl-btn-primary { background: var(--rl-accent-soft); border-color: var(--rl-accent); font-weight: 600 }
.rl-btn-danger { color: var(--rl-bad); border-color: var(--rl-bad) }
.rl-btn-ghost { border-color: transparent; background: transparent; opacity: .8 }
.rl-chip { display: inline-flex; align-items: center; padding: 1px 7px; margin-right: var(--rl-s1); border-radius: var(--rl-r-chip); background: var(--rl-surface-2); font-size: var(--rl-f-xs); line-height: 1.7; white-space: nowrap }
.rl-chip-primary { background: var(--rl-accent-soft); color: var(--rl-accent); font-weight: 600 }
.rl-chip-success { background: var(--rl-ok-soft); color: var(--rl-ok) }
.rl-chip-danger { background: var(--rl-bad-soft); color: var(--rl-bad) }
.rl-chip-warning { background: var(--rl-warn-soft); color: var(--rl-warn) }
.rl-chip-md { font-size: var(--rl-f-sm); padding: 2px 9px }
.rl-field { display: flex; flex-direction: column; gap: var(--rl-s2); margin-top: var(--rl-s3) }
.rl-field-label { font-size: var(--rl-f-sm); font-weight: 600 }
.rl-field-hint { font-size: var(--rl-f-xs); opacity: var(--rl-muted); line-height: 1.6 }
.rl-field-row { display: flex; align-items: center; gap: var(--rl-s3); flex-wrap: wrap; margin: var(--rl-s3) 0 }
.rl-field-row-label { min-width: 150px; font-size: var(--rl-f-md) }
.rl-switch-field { display: flex; flex-direction: column; gap: var(--rl-s1); margin-top: var(--rl-s3) }
.rl-switch-line { display: flex; align-items: center; justify-content: space-between; gap: var(--rl-s3) }
.rl-switch-text { font-size: var(--rl-f-md) }
.rl-switch-hint { font-size: var(--rl-f-xs); opacity: var(--rl-muted); line-height: 1.6 }
.rl-switch { position: relative; width: 38px; height: 22px; padding: 0; border-radius: var(--rl-r-chip); border: 1px solid var(--rl-line-strong); background: var(--rl-surface-2); cursor: pointer; transition: background-color var(--rl-t), border-color var(--rl-t), opacity var(--rl-t); flex: 0 0 auto }
.rl-switch-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--rl-fg); opacity: .6 }
.rl-switch-on { background: var(--rl-accent-soft); border-color: var(--rl-accent) }
.rl-switch-on .rl-switch-thumb { left: 18px; opacity: 1; background: var(--rl-accent) }
.rl-switch:disabled { opacity: .45; cursor: not-allowed }
.rl-seg { display: flex; flex-wrap: wrap; gap: var(--rl-s1); padding: var(--rl-s1); border: 1px solid var(--rl-line); border-radius: var(--rl-r-ctl); background: var(--rl-surface) }
.rl-seg-item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 76px; padding: 6px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color var(--rl-t), border-color var(--rl-t), opacity var(--rl-t) }
.rl-seg-item:hover:not(:disabled) { background: var(--rl-hover) }
.rl-seg-item:disabled { opacity: .45; cursor: not-allowed }
.rl-seg-checked { background: var(--rl-accent-soft); border-color: var(--rl-accent) }
.rl-seg-name { font-size: var(--rl-f-sm); line-height: 1.35 }
.rl-seg-checked .rl-seg-name { font-weight: 600 }
.rl-seg-sub { font-size: 10px; opacity: .6; line-height: 1.3 }
.rl-seg-warn-mark { color: var(--rl-warn) }
.rl-impact { display: flex; flex-wrap: wrap; gap: var(--rl-s2); align-items: baseline; margin-top: var(--rl-s3); font-size: var(--rl-f-sm); line-height: 1.6 }
.rl-impact-text { flex: 1 1 auto; min-width: 200px }
.rl-impact-warn { color: var(--rl-warn) }
.rl-applied { font-size: var(--rl-f-xs); opacity: var(--rl-muted); margin-top: var(--rl-s2); line-height: 1.6 }
.rl-applied-warn { color: var(--rl-warn); opacity: 1 }
.rl-table { width: 100%; border-collapse: collapse; font-size: var(--rl-f-sm); margin-top: var(--rl-s2) }
.rl-th { padding: 6px 10px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--rl-line-strong); white-space: nowrap; font-size: var(--rl-f-xs); opacity: .85 }
.rl-td { padding: 6px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--rl-line) }
.rl-table tbody tr:nth-child(even) { background: var(--rl-surface) }
.rl-table tbody tr:hover { background: var(--rl-hover) }
.rl-cell-sub { margin-top: 2px; line-height: 1.7 }
.rl-td-warn { color: var(--rl-warn) }
.rl-td-nowrap { white-space: nowrap }
.rl-select { padding: 4px 8px; border-radius: var(--rl-r-ctl); border: 1px solid var(--rl-line-strong); background: var(--rl-surface-2); color: inherit; font: inherit; font-size: var(--rl-f-sm); max-width: 100% }
.rl-select-warn { color: var(--rl-warn); border-color: var(--rl-warn) }
.rl-search { width: 100%; padding: 6px 10px; border-radius: var(--rl-r-ctl); border: 1px solid var(--rl-line-strong); background: var(--rl-surface); color: inherit; font: inherit; font-size: var(--rl-f-sm) }
.rl-search::placeholder { color: inherit; opacity: .45 }
.rl-muted { opacity: var(--rl-muted); font-size: var(--rl-f-sm) }
.rl-muted-block { opacity: var(--rl-muted); font-size: var(--rl-f-sm); margin-top: var(--rl-s2); line-height: 1.6 }
.rl-status { font-size: var(--rl-f-sm); opacity: .82; margin-top: var(--rl-s2); line-height: 1.6 }
.rl-status-ok { color: var(--rl-ok); opacity: 1 }
.rl-status-bad { color: var(--rl-bad); opacity: 1 }
.rl-status-warn { color: var(--rl-warn); opacity: 1 }
.rl-text-ok { color: var(--rl-ok) }
.rl-text-bad { color: var(--rl-bad) }
.rl-text-warn { color: var(--rl-warn) }
.rl-hint { font-size: var(--rl-f-sm); opacity: var(--rl-muted); margin-top: var(--rl-s3); line-height: 1.65 }
.rl-loading { padding: var(--rl-s5); font-size: var(--rl-f-md); opacity: .7 }
.rl-disclosure { margin-top: var(--rl-s3) }
.rl-disclosure-summary { cursor: pointer; user-select: none; font-size: var(--rl-f-sm); opacity: .78; padding: 2px 0 }
.rl-disclosure-body { margin-top: var(--rl-s2) }
.rl-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--rl-s3); flex-wrap: wrap; margin-top: var(--rl-s2) }
.rl-toolbar-main { display: flex; align-items: center; gap: var(--rl-s2); flex-wrap: wrap }
.rl-toolbar-meta { font-size: var(--rl-f-xs); opacity: var(--rl-muted); white-space: nowrap }
.rl-empty { padding: var(--rl-s5) var(--rl-s4); border: 1px dashed var(--rl-line); border-radius: var(--rl-r-ctl); text-align: center; margin-top: var(--rl-s3) }
.rl-empty-title { font-size: var(--rl-f-md); font-weight: 600 }
.rl-empty-hint { font-size: var(--rl-f-sm); opacity: var(--rl-muted); margin-top: var(--rl-s2); line-height: 1.6 }
.rl-empty-action { margin-top: var(--rl-s3) }
.rl-toast { position: fixed; right: var(--rl-s4); bottom: var(--rl-s4); z-index: 50; display: flex; align-items: center; gap: var(--rl-s2); max-width: min(420px, calc(100vw - 32px)); padding: var(--rl-s3) var(--rl-s4); border-radius: var(--rl-r-ctl); border: 1px solid var(--rl-line-strong); background: var(--rl-surface-2); font-size: var(--rl-f-sm) }
.rl-toast-ok { border-color: var(--rl-ok); background: var(--rl-ok-soft) }
.rl-toast-bad { border-color: var(--rl-bad); background: var(--rl-bad-soft); color: var(--rl-bad) }
.rl-subtitle { font-size: var(--rl-f-md); font-weight: 600; margin: var(--rl-s4) 0 var(--rl-s1) }
/* 模型搜索添加（FEAT-004 §3.4.1）：输入 + 结果列表（≤8 条）+ 精确键直加 */
.rl-search-wrap { display: flex; flex-direction: column; gap: var(--rl-s1); margin-top: var(--rl-s2) }
.rl-search-list { display: flex; flex-direction: column; gap: var(--rl-s1); margin-top: var(--rl-s2); padding: var(--rl-s1); max-height: 260px; overflow-y: auto; border: 1px solid var(--rl-line); border-radius: var(--rl-r-ctl); background: var(--rl-surface) }
.rl-search-item { display: flex; align-items: center; justify-content: space-between; gap: var(--rl-s2); width: 100%; padding: var(--rl-s1) var(--rl-s2); border: 1px solid transparent; border-radius: var(--rl-r-ctl); background: transparent; color: inherit; font: inherit; font-size: var(--rl-f-sm); line-height: 1.5; text-align: left; cursor: pointer; transition: background-color var(--rl-t), border-color var(--rl-t) }
.rl-search-item:hover { background: var(--rl-hover); border-color: var(--rl-line) }
.rl-search-item-main { min-width: 0; overflow-wrap: anywhere }
.rl-search-item-chips { display: flex; flex-wrap: wrap; gap: var(--rl-s1); justify-content: flex-end }
.rl-search-exact { display: flex; align-items: center; gap: var(--rl-s2); flex-wrap: wrap; margin-top: var(--rl-s2) }
/* 支持矩阵（FEAT-004 §3.4.3）：7 档单元格 ✓/✗/? */
.rl-matrix-wrap { margin-top: var(--rl-s2); overflow-x: auto }
.rl-matrix-table .rl-th, .rl-matrix-table .rl-td { text-align: center }
.rl-matrix-table .rl-th:first-child, .rl-matrix-table .rl-td:first-child { text-align: left }
.rl-matrix-cell { font-weight: 600 }
.rl-matrix-table .rl-matrix-cell { min-width: 20px }
.rl-matrix-yes { color: var(--rl-ok) }
.rl-matrix-no { color: var(--rl-bad) }
.rl-matrix-unknown { opacity: .5 }
/* 可排序表头（FEAT-004 §3.6.3）：button 承载点击与键盘焦点，th 承载 aria-sort */
.rl-sort-btn { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-size: var(--rl-f-xs); font-weight: 600; opacity: .85; cursor: pointer; transition: opacity var(--rl-t) }
.rl-sort-btn:hover { opacity: 1; text-decoration: underline }
@media (max-width: 1080px) { .rl-split { grid-template-columns: 1fr } }
@media (max-width: 900px) { .rl-stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
@media (max-width: 720px) {
  .rl-split { grid-template-columns: 1fr }
  .rl-hide-sm { display: none }
  .rl-header-main { flex-direction: column }
  .rl-header-actions { align-items: flex-start }
  .rl-seg-item { flex: 1 1 calc(33% - 8px); min-width: 0 }
  .rl-card { padding: var(--rl-s3) }
  .rl-table { font-size: var(--rl-f-xs) }
  .rl-th, .rl-td { padding: 5px 6px }
}
@media (max-width: 520px) { .rl-stats-grid { grid-template-columns: 1fr } }
/* 动效偏好：仅关闭颜色/透明度过渡，不改变布局与可读性（规范 §2.4） */
@media (prefers-reduced-motion: reduce) { .rl-root * { transition: none !important } }
`

    /** 一次性注入样式表；HMR/页面重挂载时按 id 幂等复用。 */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || document === null || document.head === null || document.head === undefined) return
        if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.setAttribute('data-dsh-reasoning-level', '1')
        style.textContent = STYLESHEET
        document.head.appendChild(style)
      } catch (error) {
        // 样式是渐进增强：无 document（冒烟 vm 沙箱）或宿主 head 不可写时退化为
        // 无样式，但节点树必须照常渲染——冒烟只看结构与文本。
      }
    }

    // ── 基元组件（规范 §2/§3，全部只挂 .rl-* className）────────────────────
    /** 卡片：标题 + 可选副标题 + 可选右侧操作区（页头主操作下沉到卡片时用）。 */
    function Card(props) {
      const { title, subtitle, actions, children, className } = props
      const hasHead = title !== undefined || subtitle !== undefined || actions !== undefined
      return el('section', { className: 'rl-card' + (className !== undefined ? ' ' + className : '') },
        hasHead
          ? el('div', { className: 'rl-card-head' },
              el('div', { className: 'rl-card-head-main' },
                el('span', { className: 'rl-card-accent', 'aria-hidden': 'true' }),
                el('div', null,
                  title !== undefined ? el('h3', { className: 'rl-card-title' }, title) : null,
                  subtitle !== undefined ? el('p', { className: 'rl-card-sub' }, subtitle) : null)),
              actions !== undefined ? el('div', { className: 'rl-card-actions' }, actions) : null)
          : null,
        children)
    }

    /** 按钮四态：primary / secondary / danger / ghost；统一 type=button 防宿主表单误提交。 */
    function Button(props) {
      const { variant, size, className, children, ...rest } = props
      const cls = 'rl-btn rl-btn-' + (variant !== undefined ? variant : 'secondary')
        + (size === 'sm' ? ' rl-btn-sm' : '')
        + (className !== undefined ? ' ' + className : '')
      return el('button', { type: 'button', ...rest, className: cls }, children)
    }

    /** 等级徽章：variant 语义底色 + 可选尺寸（默认小号，矩阵/摘要用 md）。 */
    function LevelChip(props) {
      const { label, variant, size } = props
      return el('span', {
        className: 'rl-chip rl-chip-' + (variant !== undefined ? variant : 'neutral') + (size === 'md' ? ' rl-chip-md' : ''),
      }, label)
    }

    /** 概览磁贴：主值大号、副值 muted；extra 子树用于档位刻度条等结构化信息。 */
    function StatTile(props) {
      const { label, value, sub, tone, title, children } = props
      return el('div', { className: 'rl-stat', title },
        el('div', { className: 'rl-stat-label' }, label),
        el('div', { className: 'rl-stat-value' }, value),
        sub !== undefined ? el('div', { className: 'rl-stat-sub' + (tone === 'warn' ? ' rl-stat-sub-warn' : '') }, sub) : null,
        children)
    }

    function EmptyState(props) {
      const { title, hint, action } = props
      return el('div', { className: 'rl-empty' },
        title !== undefined ? el('div', { className: 'rl-empty-title' }, title) : null,
        hint !== undefined ? el('div', { className: 'rl-empty-hint' }, hint) : null,
        action !== undefined ? el('div', { className: 'rl-empty-action' }, action) : null)
    }

    function Toolbar(props) {
      const { children, meta } = props
      return el('div', { className: 'rl-toolbar' },
        el('div', { className: 'rl-toolbar-main' }, children),
        meta !== undefined ? el('div', { className: 'rl-toolbar-meta' }, meta) : null)
    }

    /**
     * 开关：原生 checkbox 在设置页里没有可见的状态语义，改用 role="switch" +
     * aria-checked（规范 §3.3.1），键盘 Enter/Space 由原生 button 触发。
     */
    function Switch(props) {
      const { checked, onChange, label, hint, disabled } = props
      return el('div', { className: 'rl-switch-field' },
        el('div', { className: 'rl-switch-line' },
          el('span', { className: 'rl-switch-text' }, label),
          el('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': checked === true,
            'aria-label': label,
            disabled: disabled === true,
            className: 'rl-switch' + (checked === true ? ' rl-switch-on' : ''),
            onClick: () => { if (disabled !== true) onChange(checked !== true) },
          }, el('span', { className: 'rl-switch-thumb', 'aria-hidden': 'true' }))),
        hint !== undefined ? el('div', { className: 'rl-switch-hint' }, hint) : null)
    }

    /**
     * 7 档分段控件（规范 §3.3.2）：radiogroup/radio + aria-checked；
     * 方向键移动 roving focus，Enter/Space 由原生 button click 完成选中。
     * 当前档位无任何模型支持时，段内显示 ⚠（不隐藏，避免“我的设置去哪了”）。
     */
    function SegmentedControl(props) {
      const { t, lang, value, onChange, disabled, warnLevel } = props
      const [focusIndex, setFocusIndex] = useState(-1)
      const activeIndex = LEVELS.indexOf(value)
      const tabIndexFor = (index) => (index === (focusIndex >= 0 ? focusIndex : activeIndex) ? 0 : -1)
      const moveFocus = (event, delta) => {
        event.preventDefault()
        const base = focusIndex >= 0 ? focusIndex : (activeIndex >= 0 ? activeIndex : 0)
        const next = (base + delta + LEVELS.length) % LEVELS.length
        setFocusIndex(next)
        // 焦点移动只能在真实 DOM 上完成；冒烟沙箱没有 DOM，但 keydown 只在浏览器触发。
        const group = event.currentTarget !== undefined && event.currentTarget !== null ? event.currentTarget.parentNode : undefined
        const target = group !== undefined && group !== null && group.children !== undefined ? group.children[next] : undefined
        if (target !== undefined && target !== null && typeof target.focus === 'function') target.focus()
      }
      return el('div', { className: 'rl-seg', role: 'radiogroup', 'aria-label': t('level') },
        LEVELS.map((item, index) => {
          const checked = item === value
          const hint = levelHint(item, lang)
          const warn = checked && warnLevel === item
          return el('button', {
            key: item,
            type: 'button',
            role: 'radio',
            'aria-checked': checked,
            'data-level': item,
            tabIndex: disabled === true ? -1 : tabIndexFor(index),
            disabled: disabled === true,
            className: 'rl-seg-item' + (checked ? ' rl-seg-checked' : ''),
            title: hint !== undefined ? hint.scenario : undefined,
            onClick: () => {
              if (disabled === true) return
              setFocusIndex(index)
              // 与旧 <select> 对齐：选中已选中的档位不产生一次冗余写入。
              if (item !== value) onChange(item)
            },
            onKeyDown: (event) => {
              if (disabled === true) return
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') moveFocus(event, 1)
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') moveFocus(event, -1)
            },
          },
            el('span', { className: 'rl-seg-name' },
              levelLabel(item, lang),
              warn ? el('span', { className: 'rl-seg-warn-mark', 'aria-label': t('supportNo') }, ' ⚠') : null),
            el('span', { className: 'rl-seg-sub' }, hint !== undefined ? hint.meaning : ''))
        }))
    }

    function SearchField(props) {
      const { value, onChange, placeholder, label, disabled } = props
      return el('input', {
        type: 'search',
        className: 'rl-search',
        value: value !== undefined ? value : '',
        placeholder: placeholder !== undefined ? placeholder : '',
        'aria-label': label !== undefined ? label : placeholder,
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Disclosure(props) {
      const { summary, children, open } = props
      return el('details', { className: 'rl-disclosure', open: open === true ? true : undefined },
        el('summary', { className: 'rl-disclosure-summary' }, summary),
        el('div', { className: 'rl-disclosure-body' }, children))
    }

    function StatusPill(props) {
      const { variant, title, children } = props
      return el('span', {
        className: 'rl-pill rl-pill-' + (variant !== undefined ? variant : 'muted'),
        title,
        // 降级胶囊的可见文本只有「功能降级」，完整缺失清单在 title 里；补
        // aria-label 让辅助技术读到同一份原因（与鼠标悬停等价）。
        'aria-label': title !== undefined ? title : undefined,
      },
        el('span', { className: 'rl-pill-dot', 'aria-hidden': 'true' }),
        children)
    }

    /** 轻量 toast：成功用 polite status，失败用 alert/assertive（规范 §5.1）。 */
    function Toast(props) {
      const { message, kind, actionLabel, onAction } = props
      const bad = kind === 'bad'
      return el('div', {
        className: 'rl-toast ' + (bad ? 'rl-toast-bad' : 'rl-toast-ok'),
        role: bad ? 'alert' : 'status',
        'aria-live': bad ? 'assertive' : 'polite',
      },
        el('span', null, message),
        actionLabel !== undefined ? el(Button, { variant: 'ghost', size: 'sm', onClick: onAction }, actionLabel) : null)
    }

    // ── 影响预览的数据推导（规范 §3.3.3）────────────────────────────────────
    const asArray = (value) => (Array.isArray(value) ? value : [])
    /** probeEfforts 的 value 是 { level: wire }；null wire 表示 off 已实测支持，故按 key 取档。 */
    function measuredLevels(map) {
      if (map === null || map === undefined || typeof map !== 'object' || Array.isArray(map)) return null
      return Object.keys(map).filter((key) => LEVELS.includes(key))
    }

    /**
     * 某档位的支持面：probeEfforts（实测固化）> lastProbe.working（本次实测，含未写入
     * 配置的模型）> 目录声明 efforts > 未知。只有 blocked、没有 working/rejected 的
     * 探测结果不算“已知”——网关拒绝不等于模型不支持。
     */
    function computeImpact(options) {
      const { level, catalog, probeEfforts, lastProbe } = options
      const entries = new Map()
      for (const entry of asArray(catalog !== null && catalog !== undefined ? catalog.list : null)) {
        if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string') entries.set(entry.key, entry)
      }
      const efforts = probeEfforts !== null && typeof probeEfforts === 'object' && !Array.isArray(probeEfforts) ? probeEfforts : {}
      const probeModels = lastProbe !== null && typeof lastProbe === 'object' && lastProbe.models !== null && typeof lastProbe.models === 'object'
        ? lastProbe.models
        : {}
      let supported = 0
      let skipped = 0
      let unknown = 0
      const skippedKeys = []
      for (const [key, entry] of entries) {
        let levels = measuredLevels(efforts[key])
        if (levels === null || levels.length === 0) {
          levels = null
          const probed = probeModels[key]
          if (probed !== null && typeof probed === 'object') {
            const working = asArray(probed.working).filter((item) => LEVELS.includes(item))
            const rejected = asArray(probed.rejected).filter((item) => LEVELS.includes(item))
            if (working.length > 0 || rejected.length > 0) levels = working
          }
        }
        if (levels === null) {
          const declared = asArray(entry.efforts).filter((item) => LEVELS.includes(item))
          if (declared.length > 0) levels = declared
        }
        if (levels === null) { unknown += 1; continue }
        if (levels.includes(level)) supported += 1
        else {
          skipped += 1
          // 预览用 provider: model 形态（§3.3 示例「cursor: glm-5.3-flash」），比原始
          // 的 provider/model 键更易读；模型列表仍保持原键。
          const sep = key.indexOf('/')
          skippedKeys.push(sep > 0 ? key.slice(0, sep) + ': ' + key.slice(sep + 1) : key)
        }
      }
      const known = entries.size - unknown
      return {
        total: entries.size,
        supported,
        skipped,
        unknown,
        known,
        skippedNames: skippedKeys.slice(0, 3),
        noKnownSupport: known > 0 && supported === 0,
      }
    }

    function ImpactPreview(props) {
      const { t, lang, level, impact } = props
      const parts = [t('impactPreview', levelLabel(level, lang), String(impact.supported))]
      if (impact.skipped > 0) parts.push(t('impactSkip', String(impact.skipped), impact.skippedNames.join(t('comma'))))
      if (impact.unknown > 0) parts.push(t('impactUnknown', String(impact.unknown)))
      return el('div', { className: 'rl-impact', role: 'status', 'aria-live': 'polite' },
        el('span', { className: 'rl-impact-text' + (impact.noKnownSupport ? ' rl-impact-warn' : '') }, parts.join(t('comma'))))
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
    /** 027-F4：持久化结局 → i18n key（未知值原样显示，避免服务端新增枚举击穿渲染）。 */
    const PERSISTED_KEYS = {
      'converged': 'persistedConverged',
      'written': 'persistedWritten',
      'no-change-already-correct': 'persistedNoChange',
      'pending-apply': 'persistedPending',
      'skipped:not-in-pi-ai-config': 'persistedNotInConfig',
      // FEAT-004 ⑦（设计 §10.1）：宿主官方适配器管辖——与「不在 pi-ai 配置」是不同结局
      'skipped:official-adapter': 'persistedOfficialAdapter',
      'skipped:no-working': 'persistedNoWorking',
      'persist-error': 'persistedError',
    }
    /** apply per-model outcome → 持久化结局（027-F1：apply 后刷新本地结果表列）。 */
    const OUTCOME_TO_PERSISTED = {
      'written': 'written',
      'persist-error': 'persist-error',
      'not-in-pi-ai-config': 'skipped:not-in-pi-ai-config',
      'no-working-levels': 'skipped:no-working',
    }
    /**
     * FEAT-004（设计 §10.1 第三态）：持久化结局 → 文案。`skipped:not-in-pi-ai-config`
     * 必须按 provider 是否已在 llm-pi-ai.providers 里分流：
     *  · provider 在、模型未列入 → 「在 <provider> 下没有这个模型——添加后即可固化」（下一步 = 添加模型）；
     *  · provider 整体不在 → 该模型由其他适配器提供（等级由提供方控制，无需固化）。
     * 判定依据只有一份事实源（describe 拿到的 provider 名集合），不靠文案猜测。
     */
    function persistedText(t, outcome, provider, piAiProviders) {
      if (outcome === undefined || outcome === null) return '—'
      if (outcome === 'skipped:not-in-pi-ai-config') {
        const known = Array.isArray(piAiProviders) ? piAiProviders : []
        return known.includes(provider) ? t('persistedNotInConfigModel', provider) : t('persistedOtherAdapter')
      }
      const key = PERSISTED_KEYS[outcome]
      return key !== undefined ? t(key) : String(outcome)
    }
    /**
     * FEAT-004 ⑦（设计 §6.2）：blocked 档位的错误归因映射。按设计表顺序匹配
     * code+message 文本特征；命中返回一句人话，未命中返回原样 `code: message`
     * （截断 120 字符）——绝不把未知错误硬塞进一个错误分类（开发原则 1：不编造）。
     * 旧 lastProbe / 旧服务端无 blockedReasons 时由渲染层按「未知原因」降级。
     */
    const PROBE_REASON_RULES = [
      { pattern: /auth|unauthorized|api[ _-]?key|credential|401|403/i, key: 'probeReasonAuth' },
      { pattern: /not[ _-]?found|404|model/i, key: 'probeReasonNotFound' },
      { pattern: /rate|429|quota/i, key: 'probeReasonRate' },
      { pattern: /abort|timeout|timed out/i, key: 'probeReasonTimeout' },
    ]
    const PROBE_REASON_MAX_CHARS = 120
    /** blocked 档位的归因文案：reason 缺席/坏值 → 「未知原因」。 */
    function probeReasonText(t, reason) {
      if (reason === null || reason === undefined || typeof reason !== 'object' || Array.isArray(reason)) return t('probeReasonUnknown')
      const code = typeof reason.code === 'string' ? reason.code : ''
      const message = typeof reason.message === 'string' ? reason.message : ''
      const haystack = code + ' ' + message
      for (const rule of PROBE_REASON_RULES) {
        if (rule.pattern.test(haystack)) return t(rule.key)
      }
      const raw = code !== '' && message !== '' ? code + ': ' + message : (code !== '' ? code : message)
      if (raw === '') return t('probeReasonUnknown')
      return raw.length > PROBE_REASON_MAX_CHARS ? raw.slice(0, PROBE_REASON_MAX_CHARS) + '…' : raw
    }
    /** 等级对比的排序列：真实档位按 LEVELS 顺序，`(默认)` 桶排在最后。 */
    const levelCompareRank = (levelKey) => {
      const index = LEVELS.indexOf(levelKey)
      return index < 0 ? LEVELS.length : index
    }
    /**
     * FEAT-005（设计 §3.6.4/§10.4）：等级对比——同一模型不同等级的实际代价。
     * 唯一数据源 = stats.models[key].byLevel（服务端 v0.9.0 起的 per-level 聚合）；
     * 只渲染 ≥2 个等级桶的模型（单档无法对照）。**禁止**用 efforts 计数反推
     * token/耗时——历史调用没有 per-level 拆分，那些数字不存在（开发原则 1）。
     * 旧服务端（无 byLevel）→ 空态「数据自 v0.9.0 起累积」，不显示空表头。
     */
    const LEVEL_COMPARE_MIN_BUCKETS = 2
    function LevelCompare(props) {
      const { stats, t, lang } = props
      const models = stats !== null && typeof stats === 'object' && stats.models !== null && typeof stats.models === 'object' ? stats.models : {}
      const rows = []
      for (const [key, agg] of Object.entries(models)) {
        const byLevel = agg !== null && typeof agg === 'object' && agg.byLevel !== null
          && typeof agg.byLevel === 'object' && !Array.isArray(agg.byLevel)
          ? agg.byLevel
          : {}
        const buckets = []
        for (const [levelKey, bucket] of Object.entries(byLevel)) {
          if (levelKey !== '(默认)' && !LEVELS.includes(levelKey)) continue
          if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
          const calls = typeof bucket.calls === 'number' && Number.isFinite(bucket.calls) && bucket.calls > 0 ? bucket.calls : 0
          if (calls === 0) continue
          buckets.push({ levelKey, bucket, calls })
        }
        if (buckets.length < LEVEL_COMPARE_MIN_BUCKETS) continue
        buckets.sort((a, b) => levelCompareRank(a.levelKey) - levelCompareRank(b.levelKey))
        rows.push({ key, buckets })
      }
      /**
       * R0-P3-6：空态归因。rows 为空可能是两种情况——
       *  · 模型只有非标准档（如自定义 effort `ultra`）：wire byLevel 被受控键集合
       *    （7 档 + `(默认)`）过滤后为空，但 efforts 里有非受控键 → 「档位不标准」；
       *  · 其余（旧快照无 byLevel / 样本不足）→ 设计 §10.4 的「数据自 v0.9.0 起累积」。
       * 只按事实判定（byLevel 无受控桶 && efforts 有非受控键），不猜测。
       */
      const hasOnlyNonStandardLevels = (() => {
        for (const agg of Object.values(models)) {
          if (agg === null || typeof agg !== 'object' || Array.isArray(agg)) continue
          const byLevel = agg.byLevel !== null && typeof agg.byLevel === 'object' && !Array.isArray(agg.byLevel) ? agg.byLevel : {}
          if (Object.keys(byLevel).some((key) => key === DEFAULT_EFFORT_KEY || LEVELS.includes(key))) continue
          const efforts = agg.efforts !== null && typeof agg.efforts === 'object' && !Array.isArray(agg.efforts) ? agg.efforts : {}
          if (Object.keys(efforts).some((key) => key !== DEFAULT_EFFORT_KEY && !LEVELS.includes(key))) return true
        }
        return false
      })()
      const average = (sum, calls) => (typeof sum === 'number' && Number.isFinite(sum) ? String(Math.round(sum / calls)) : '0')
      return el(Disclosure, { summary: t('levelCompare') },
        rows.length === 0
          ? el('div', { className: 'rl-muted-block' }, t(hasOnlyNonStandardLevels ? 'levelCompareNonStandard' : 'levelCompareEmpty'))
          : el('div', null, rows.map((row) => el('div', { key: row.key, className: 'rl-field' },
              el('div', { className: 'rl-field-label' }, row.key),
              el('table', { className: 'rl-table' },
                el('thead', null, el('tr', null,
                  el('th', { className: 'rl-th', scope: 'col' }, t('effort')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('levelCompareCalls')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('levelCompareDuration')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('levelCompareOutput')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('levelCompareThinking')))),
                el('tbody', null, row.buckets.map((item) => {
                  const view = item.bucket
                  const thinking = typeof view.reasoningTokens === 'number' && view.reasoningTokens > 0
                    ? average(view.reasoningTokens, item.calls) + ' tok'
                    : '—'
                  // 网关未回报 reasoning tokens 时，用 title 说明「不可观测」而非「没有思考」；
                  // rt 与 rc 都无数据（R0-P2-5 / 设计 §10.2）→ 明确「该网关未回报 reasoning tokens」。
                  const thinkingTitle = typeof view.reasoningTokens === 'number' && view.reasoningTokens > 0
                    ? undefined
                    : (typeof view.reasoningChars === 'number' && view.reasoningChars > 0 ? t('thinkingApprox') : t('thinkingUnreported'))
                  return el('tr', { key: item.levelKey },
                    el('td', { className: 'rl-td' }, effortLabel(item.levelKey, lang, t)),
                    el('td', { className: 'rl-td' }, String(item.calls)),
                    el('td', { className: 'rl-td' }, average(view.durationMs, item.calls) + 'ms'),
                    el('td', { className: 'rl-td' }, average(view.outputTokens, item.calls)),
                    el('td', { className: 'rl-td', title: thinkingTitle }, thinking))
                })))))))
    }
    /**
     * 探测编排（页面级，规范 §3.1/§5.2）：页头主按钮与观测卡共享同一份状态。
     * 请求形状与固化/回显语义保持原样（只把入口从观测卡上移到页头），失败仍红、
     * 重跑成功仍复位绿色（N2 语义）。
     */
    function useProbe(options) {
      const { t, targets, stats } = options
      const [probing, setProbing] = useState(false)
      const [progress, setProgress] = useState('')
      const [progressIndex, setProgressIndex] = useState(0)
      const [progressTotal, setProgressTotal] = useState(0)
      const [results, setResults] = useState([])
      const [summary, setSummary] = useState('')
      const [summaryOk, setSummaryOk] = useState(true)
      const probingRef = useRef(false)
      const lastProbeTRef = useRef(0)

      // 027-F3 持久化回显：渲染期派生首个快照，而不是“先空后填”的 effect——
      // 冒烟只渲染两轮，回显若晚一轮进入 state，结果表会错过断言窗口。
      // 去重键 = lastProbe.t：同一份持久化结果只回显一次，不覆盖用户本轮探测结果。
      let shownResults = results
      let shownSummary = summary
      const lastProbe = stats !== null && typeof stats === 'object' ? stats.lastProbe : undefined
      if (!probing && !probingRef.current && results.length === 0 && summary === ''
        && lastProbe !== null && lastProbe !== undefined && typeof lastProbe.t === 'number'
        && lastProbe.t !== lastProbeTRef.current) {
        const entries = Object.entries(lastProbe.models ?? {})
        if (entries.length > 0) {
          shownResults = entries.map(([key, entry]) => {
            const sep = key.indexOf('/')
            return {
              key,
              provider: sep > 0 ? key.slice(0, sep) : key,
              model: sep > 0 ? key.slice(sep + 1) : '',
              working: Array.isArray(entry.working) ? entry.working : [],
              rejected: Array.isArray(entry.rejected) ? entry.rejected : [],
              blocked: Array.isArray(entry.blocked) ? entry.blocked : [],
              // FEAT-004 ⑦：blocked 归因随持久化回显重建（旧 lastProbe 无该字段 → 缺席，
              // 渲染层按「未知原因」降级，不崩、不编造原因）。
              blockedReasons: entry.blockedReasons !== null && entry.blockedReasons !== undefined
                && typeof entry.blockedReasons === 'object' && !Array.isArray(entry.blockedReasons)
                ? entry.blockedReasons
                : undefined,
              persisted: typeof entry.persisted === 'string' ? entry.persisted : undefined,
            }
          })
          shownSummary = t('probeRestored', fmtTime(lastProbe.t))
        }
      }
      useEffect(() => {
        // 用户已开始新一轮探测时，旧的持久化快照不得覆盖本轮结果（回显只在挂载窗口生效）。
        if (probingRef.current || shownResults === results) return
        lastProbeTRef.current = lastProbe.t
        setResults(shownResults)
        setSummary(shownSummary)
        setSummaryOk(true)
      })

      const probeAll = () => {
        if (probing || targets.length === 0) return
        setProbing(true)
        probingRef.current = true
        setProgress('')
        setProgressIndex(0)
        setProgressTotal(targets.length)
        setSummary('')
        setSummaryOk(true)
        setResults([])
        ;(async () => {
          const collected = []
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i]
            setProgress(t('probing', String(i + 1), String(targets.length), target.key))
            setProgressIndex(i + 1)
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
              collected.push({ key: target.key, ...data })
            } catch (error) {
              collected.push({ provider: target.provider, model: target.model, key: target.key, error: t('probeFail'), working: [], rejected: [], blocked: [] })
            } finally {
              window.clearTimeout(timer)
            }
            setResults(collected.slice())
          }
          let applyNote = ''
          try {
            const response = await fetch('/reasoning-level-stats/probe/apply', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results: collected }),
            })
            const applied = await response.json()
            // 027-F1（MAINT-019 P2-2 措辞诚实化）+ R0-P2-1：按结局分类计数——
            // 「固化 0 处」不再掩盖「已与实测一致」「官方适配器管理」「其他适配器提供」
            // 「暂无可固化等级」的真实分布；两种「未写入」各有独立 reason（服务端分流）。
            const skippedList = Array.isArray(applied.skipped) ? applied.skipped : []
            const countReason = (reason) => skippedList.filter((s) => s !== null && s !== undefined && s.reason === reason).length
            applyNote = t('comma') + t('probeDone',
              String(collected.length),
              String(applied.writes ?? (applied.error ? '—' : 0)),
              String(countReason('already-verified')),
              String(countReason('official-adapter')),
              String(countReason('not-in-pi-ai-config')),
              String(countReason('no-working-levels')))
            if (applied.error !== undefined) {
              applyNote += t('paren', applied.error)
              setSummaryOk(false)
            }
            // 027-F1/F4：按 apply per-model 结局刷新本地结果表的「持久化」列
            if (Array.isArray(applied.outcomes)) {
              const outcomeByKey = new Map()
              for (const o of applied.outcomes) {
                if (o !== null && o !== undefined && typeof o.key === 'string') outcomeByKey.set(o.key, o.outcome)
              }
              setResults((prev) => prev.map((r) => {
                if (!outcomeByKey.has(r.key)) return r
                const oc = outcomeByKey.get(r.key)
                let persisted = r.persisted
                if (oc === 'not-in-pi-ai-config' && r.persisted === 'skipped:official-adapter') {
                  // FEAT-004 ⑦（设计 §10.1）：apply 的 not-in-pi-ai-config 结局不得覆盖
                  // 探测阶段已判定的官方适配器归因（两者是不同结局、不同用户动作）。
                  persisted = r.persisted
                } else if (OUTCOME_TO_PERSISTED[oc] !== undefined) persisted = OUTCOME_TO_PERSISTED[oc]
                else if (oc === 'already-verified') persisted = r.persisted !== undefined ? r.persisted : 'no-change-already-correct'
                return { ...r, persisted }
              }))
            }
          } catch (error) {
            applyNote = t('comma') + t('probeApplyFail')
            setSummaryOk(false)
          }
          setSummary(applyNote)
          setProgress('')
          setProgressIndex(0)
          setProgressTotal(0)
          setProbing(false)
          probingRef.current = false
        })()
      }

      return {
        targets,
        probing,
        progress,
        progressIndex,
        progressTotal,
        results: shownResults,
        summary: shownSummary,
        summaryOk,
        probeAll,
      }
    }

    /** 最近调用表渲染行数上限 = 服务端 wire 窗口（statsSnapshot: recent.slice(0,100)）。
     *  R0-P3-7：文案/设计 §3.6.1 声明的「最近 100 条」必须与真实渲染行数一致——
     *  wire 窗口保持 100 不变，渲染此前只取 20 行（已对齐为全量窗口）。 */
    const RECENT_ROWS_LIMIT = 100

    /** 模型聚合表可排序列的取值（数组 = 多级比较：token 主值 + 字符次值）。 */
    const statsSortValue = (key, agg) => {
      if (key === 'think') return [agg.reasoningTokens ?? 0, agg.reasoningChars ?? 0]
      if (key === 'output') return [agg.outputTokens ?? 0]
      if (key === 'avgDur') return [agg.calls > 0 ? (agg.durationMs ?? 0) / agg.calls : 0]
      if (key === 'errRate') return [agg.errRate ?? (agg.calls > 0 ? ((agg.errors ?? 0) / agg.calls) * 100 : 0)]
      return [agg.calls ?? 0]
    }

    function StatsPanel(props) {
      const { stats, statsFailed, probe } = props
      const t = props.t || zhT
      const lang = langOf(t)
      const piAiProviders = Array.isArray(props.piAiProviders) ? props.piAiProviders : []
      const paused = props.paused === true
      const onTogglePause = typeof props.onTogglePause === 'function' ? props.onTogglePause : undefined
      // hooks 必须先于任何 early return：stats 从 null → loaded 是同一组件的合法状态
      // 切换，条件 hook 会触发 React「Rendered more hooks than during the previous
      // render」致命错误（生产环境白屏）。
      const [onlyIssues, setOnlyIssues] = useState(false)
      const [sortKey, setSortKey] = useState('calls')
      const [sortDir, setSortDir] = useState('desc')

      const exportCsv = () => {
        // R0-P3-7（设计 §9.6「CSV 增列」）：既有 8 列顺序/语义保持不破，行尾追加
        // per-level calls 列（受控键：7 档 + `(默认)`；无该等级桶导出 0）。
        const levelKeys = [...LEVELS, DEFAULT_EFFORT_KEY]
        const rows = [[t('model'), t('calls'), t('effortDist'), t('thinkTokens'), t('thinkChars'), t('outputTokens'), t('avgDurMs'), t('errRateCol'),
          ...levelKeys.map((level) => effortLabel(level, lang, t) + ' ' + t('calls'))]]
        for (const [key, agg] of Object.entries(stats.models ?? {})) {
          const byLevel = agg.byLevel !== null && agg.byLevel !== undefined && typeof agg.byLevel === 'object' && !Array.isArray(agg.byLevel) ? agg.byLevel : {}
          // CSV 内容跟随当前语言（规范 §4.1）：等级键用档名而非 wire id。
          rows.push([key, agg.calls, Object.entries(agg.efforts ?? {}).map(([k, v]) => effortLabel(k, lang, t) + '=' + v).join('|'),
            agg.reasoningTokens ?? 0, agg.reasoningChars ?? 0, agg.outputTokens ?? 0,
            agg.calls > 0 ? Math.round((agg.durationMs ?? 0) / agg.calls) : 0, agg.errRate ?? 0,
            ...levelKeys.map((level) => {
              const bucket = byLevel[level]
              if (bucket === null || bucket === undefined || typeof bucket !== 'object' || Array.isArray(bucket)) return 0
              return typeof bucket.calls === 'number' && Number.isFinite(bucket.calls) ? bucket.calls : 0
            })])
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

      if (statsFailed && stats === null) {
        return el(Card, { title: t('stats') }, el(EmptyState, { title: t('statsUnavailable') }))
      }
      if (stats === null) {
        return el(Card, { title: t('stats') }, el('div', { className: 'rl-loading' }, t('statsLoading')))
      }

      // 纯客户端派生（§5.3：不改请求）：只看异常过滤 + 列头排序（默认 calls 降序）。
      // 「只看异常」= 过滤掉 errors===0 且无建议的行（新服务端结构化 suggestionKind
      // 与旧服务端 suggestion 字符串都算「有建议」）。
      const allRows = Object.entries(stats.models ?? {})
      const hasSuggestion = (agg) => Boolean(agg.suggestion) || agg.suggestionKind !== undefined
      const filteredRows = onlyIssues === true
        ? allRows.filter(([, agg]) => (agg.errors ?? 0) !== 0 || hasSuggestion(agg))
        : allRows
      const direction = sortDir === 'asc' ? 1 : -1
      const modelRows = filteredRows.slice().sort(([ak, aa], [bk, ba]) => {
        const av = statsSortValue(sortKey, aa)
        const bv = statsSortValue(sortKey, ba)
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
          const diff = (av[i] ?? 0) - (bv[i] ?? 0)
          if (diff !== 0) return diff * direction
        }
        return ak < bk ? -1 : (ak > bk ? 1 : 0)
      })
      const toggleSort = (key) => {
        if (key === sortKey) { setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); return }
        setSortKey(key)
        setSortDir('desc')
      }
      // 可排序列头 = button（键盘可达）+ th[aria-sort]（当前排序列标注方向）。
      const sortTh = (key, label) => el('th', {
        className: 'rl-th',
        scope: 'col',
        'aria-sort': sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
      }, el('button', {
        type: 'button',
        className: 'rl-sort-btn',
        title: t('sortBy') + ': ' + label,
        onClick: () => toggleSort(key),
      }, label, sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : null))
      const blackEntries = Object.entries(stats.blacklist ?? {})
      const avgDuration = (agg) => (agg.calls > 0 && typeof agg.durationMs === 'number' ? Math.round(agg.durationMs / agg.calls) + 'ms' : '—')
      // 等级分布徽章：占比最高档高亮（primary），其余中性；桶键统一走 effortLabel
      //（R0-P2-4：`(默认)` 在 en 下必须显示 `(default)`，不能漏成中文）。
      const distChips = (efforts) => {
        const entries = Object.entries(efforts)
        const maxCount = entries.reduce((m, [, v]) => Math.max(m, v), 0)
        return entries.map(([k, v]) => el(LevelChip, { key: k, label: effortLabel(k, lang, t) + '×' + v, variant: v === maxCount ? 'primary' : 'neutral' }))
      }
      const levelChips = (list, variant) => (list ?? []).map((l) => el(LevelChip, { key: l, label: levelLabel(l, lang), variant }))
      /**
       * R0-P2-4（UX-002/FEAT-004「en 全量」）：建议列渲染。新服务端只下发结构化字段
       * （suggestionKind + suggestionParams），客户端按当前语言渲染；旧服务端只有
       * suggestion 字符串 → 原样展示（旧 wire 字段保留，只加不删）。未知 kind 不编造
       * 文案，退回旧 suggestion（仍无则 '—'）。
       */
      const suggestionText = (agg) => {
        const params = agg.suggestionParams !== null && agg.suggestionParams !== undefined
          && typeof agg.suggestionParams === 'object' && !Array.isArray(agg.suggestionParams) ? agg.suggestionParams : {}
        if (agg.suggestionKind === 'high-error-rate') {
          const rate = typeof params.errorRate === 'number' && Number.isFinite(params.errorRate)
            ? params.errorRate
            : (typeof agg.errRate === 'number' ? agg.errRate : 0)
          return t('errHigh', String(rate))
        }
        if (agg.suggestionKind === 'rejected-levels') {
          const rejected = asArray(params.rejected).map((level) => levelLabel(level, lang))
          // 空 rejected 属异常服务端数据：不渲染半截句子，退回旧字段/占位。
          if (rejected.length > 0) {
            const highest = typeof params.highest === 'string' && params.highest !== '' ? levelLabel(params.highest, lang) : undefined
            return t('rejectSug', rejected, highest)
          }
        }
        return typeof agg.suggestion === 'string' && agg.suggestion !== '' ? agg.suggestion : '—'
      }
      /**
       * FEAT-004 ⑦（设计 §6.2）：blocked 列 = 档位 chips + 归因文案。
       * 相同归因只渲染一次（真实数据常见「7 档同一错误」，逐档重复是无用噪声），
       * 档位归属由 chips 表达。`blockedReasons` 缺席（旧 lastProbe / 旧服务端）或
       * 某档无记录 → 「未知原因」，不编造分类；有归因时按 code/message 映射成人话
       * （未知原样截断），原始 code/message 放 title 供排查。
       */
      const blockedCell = (r) => {
        const blocked = asArray(r.blocked)
        if (blocked.length === 0) return r.error !== undefined ? r.error : '—'
        const reasons = r.blockedReasons !== null && typeof r.blockedReasons === 'object' && !Array.isArray(r.blockedReasons) ? r.blockedReasons : {}
        const seen = new Set()
        const lines = []
        for (const level of blocked) {
          const reason = reasons[level]
          const text = probeReasonText(t, reason)
          if (seen.has(text)) continue
          seen.add(text)
          const raw = reason !== null && typeof reason === 'object' && !Array.isArray(reason)
            ? [typeof reason.code === 'string' ? reason.code : '', typeof reason.message === 'string' ? reason.message : ''].filter((part) => part !== '').join(': ')
            : ''
          lines.push(el('div', { key: level, className: 'rl-cell-sub', title: raw !== '' ? raw : undefined }, text))
        }
        return el('div', null, el('div', null, levelChips(blocked, 'warning')), lines)
      }
      // 027-F3：空态文案区分「从未探测」（lastProbe 缺席/空 vs 已回显）
      const lastProbeEmpty = stats.lastProbe === undefined || stats.lastProbe === null
        || Object.keys(stats.lastProbe.models ?? {}).length === 0

      return el(Card, { title: t('stats') },
        el('div', { className: 'rl-subtitle' }, t('probeLabel')),
        el(Toolbar, { meta: t('probeFooter', String(probe.targets.length)) },
          el(Button, { variant: 'secondary', onClick: exportCsv }, t('export'))),
        probe.targets.length === 0
          ? el('div', { className: 'rl-muted-block' }, t('probeEmpty'))
          : null,
        probe.results.length === 0 && probe.probing === false && lastProbeEmpty
          ? el('div', { className: 'rl-muted-block' }, t('neverProbed'))
          : null,
        probe.progress !== '' ? el('div', { className: 'rl-status' }, probe.progress) : null,
        probe.summary !== ''
          ? el('div', {
              className: 'rl-status rl-probe-summary ' + (probe.summaryOk ? 'rl-status-ok' : 'rl-status-bad'),
            }, probe.summary)
          : null,
        probe.results.length > 0
          ? el('div', null,
              el('div', { className: 'rl-subtitle' }, t('probeResultsTitle')),
              el('table', { className: 'rl-table' },
                el('thead', null, el('tr', null,
                  el('th', { className: 'rl-th', scope: 'col' }, t('probeColModel')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('probeColWorking')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('probeColRejected')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('probeColBlocked')),
                  el('th', { className: 'rl-th', scope: 'col' }, t('probeColPersisted')),
                )),
                el('tbody', null, probe.results.map((r, i) => el('tr', { key: i },
                  el('td', { className: 'rl-td' }, r.key),
                  el('td', { className: 'rl-td' }, (r.working ?? []).length > 0 ? levelChips(r.working, 'success') : '—'),
                  el('td', { className: 'rl-td' }, (r.rejected ?? []).length > 0 ? levelChips(r.rejected, 'danger') : '—'),
                  el('td', { className: 'rl-td' }, blockedCell(r)),
                  el('td', { className: 'rl-td' }, persistedText(
                    t,
                    r.persisted,
                    typeof r.provider === 'string' ? r.provider : (typeof r.key === 'string' && r.key.indexOf('/') > 0 ? r.key.slice(0, r.key.indexOf('/')) : ''),
                    piAiProviders,
                  )),
                ))),
              ),
              el(Disclosure, { summary: t('probeNoteSummary') }, el('div', { className: 'rl-hint' }, t('probeNote'))),
            )
          : null,
        el('div', { className: 'rl-status' },
          t('since') + ' ' + fmtTime(stats.since) + ' ' + t('totalCalls') + ' ' + (stats.totalCalls ?? 0) + ' ' + t('callsSuffix')),
        blackEntries.length > 0
          ? el('div', { className: 'rl-status rl-status-warn' },
              t('blacklist') + blackEntries.map(([k, v]) => t('rejectEntry', k, v.join('/'))).join(t('semiSep')))
          : null,
        // 模型聚合表工具栏（FEAT-004 §3.6.1/§5.3）：暂停只停 2s 轮询（由页面 effect
        // 控制），不影响本组件渲染——「最近调用」表在暂停时照常显示。
        el(Toolbar, { meta: t('statsToolbarMeta') },
          el(Button, {
            variant: 'secondary',
            size: 'sm',
            'aria-pressed': paused,
            disabled: onTogglePause === undefined,
            onClick: () => { if (onTogglePause !== undefined) onTogglePause() },
          }, paused ? t('resumeRefresh') : t('pauseRefresh')),
          el(Button, {
            variant: 'secondary',
            size: 'sm',
            'aria-pressed': onlyIssues,
            onClick: () => setOnlyIssues(onlyIssues !== true),
          }, t('onlyIssues'))),
        el('table', { className: 'rl-table' },
          el('thead', null, el('tr', null,
            el('th', { className: 'rl-th', scope: 'col' }, t('model')),
            sortTh('calls', t('calls')),
            el('th', { className: 'rl-th', scope: 'col' }, t('effortDist')),
            sortTh('think', t('think')),
            sortTh('output', t('output')),
            sortTh('avgDur', t('avgDur')),
            sortTh('errRate', t('errRateCol')),
            el('th', { className: 'rl-th', scope: 'col' }, t('suggestion')),
          )),
          el('tbody', null, modelRows.length === 0
            ? [el('tr', { key: '__empty' }, el('td', { className: 'rl-td', colSpan: 8 }, onlyIssues === true ? t('noIssuesFound') : '—'))]
            : modelRows.map(([key, agg]) => {
                const thinking = agg.reasoningTokens > 0
                  ? String(agg.reasoningTokens) + ' tok'
                  : (agg.reasoningChars > 0 ? '~' + String(agg.reasoningChars) + t('charsUnit') : '—')
                // R0-P2-5（设计 §10.2）：rt 与 rc 都无数据时明确「该网关未回报
                // reasoning tokens」（不是「无思考」）；rt=0/rc>0 仍用字符近似说明。
                const thinkingTitle = agg.reasoningTokens > 0 ? undefined : (agg.reasoningChars > 0 ? t('thinkingApprox') : t('thinkingUnreported'))
                return el('tr', { key },
                  el('td', { className: 'rl-td' }, key),
                  el('td', { className: 'rl-td' }, String(agg.calls)),
                  el('td', { className: 'rl-td' }, distChips(agg.efforts)),
                  el('td', { className: 'rl-td', title: thinkingTitle }, thinking),
                  el('td', { className: 'rl-td' }, String(agg.outputTokens)),
                  el('td', { className: 'rl-td' }, avgDuration(agg)),
                  el('td', { className: 'rl-td' }, String(agg.errRate ?? 0)),
                  el('td', { className: 'rl-td' + (hasSuggestion(agg) ? ' rl-td-warn' : '') }, suggestionText(agg)),
                )
              })),
        ),
        // FEAT-005（设计 §3.6.4）：等级对比视图（默认折叠；只消费 per-level 聚合）
        el(LevelCompare, { stats, t, lang }),
        el('div', { className: 'rl-subtitle' }, t('recentCalls')),
        el('table', { className: 'rl-table' },
          el('thead', null, el('tr', null,
            el('th', { className: 'rl-th', scope: 'col' }, t('time')),
            el('th', { className: 'rl-th', scope: 'col' }, t('model')),
            el('th', { className: 'rl-th', scope: 'col' }, t('effort')),
            el('th', { className: 'rl-th', scope: 'col' }, t('think')),
            el('th', { className: 'rl-th', scope: 'col' }, t('output')),
            el('th', { className: 'rl-th', scope: 'col' }, t('duration')),
            el('th', { className: 'rl-th', scope: 'col' }, t('result')),
          )),
          el('tbody', null, (stats.recent ?? []).slice(0, RECENT_ROWS_LIMIT).map((r, i) => el('tr', { key: i },
            el('td', { className: 'rl-td' }, fmtTime(r.t)),
            el('td', { className: 'rl-td' }, r.provider + '/' + r.model),
            // 028-F3：(默认) 复合标注——入口无显式等级时如标注服务端推导出的将
            // 物化路由默认（defaulted），wire 实际携带该值（物化发生在插件 hook 后）
            el('td', { className: 'rl-td' }, r.effort === null
              ? (typeof r.defaulted === 'string' && r.defaulted !== '' ? t('defaultedTag', levelLabel(r.defaulted, lang)) : t('defaultTag'))
              : levelLabel(r.effort, lang)),
            el('td', { className: 'rl-td' }, r.rt !== null ? String(r.rt) + ' tok' : (r.rc !== null ? '~' + String(r.rc) + t('charsUnit') : '—')),
            el('td', { className: 'rl-td' }, r.ot === null ? '—' : String(r.ot)),
            el('td', { className: 'rl-td' }, r.duration === null ? '—' : String(r.duration) + 'ms'),
            el('td', { className: 'rl-td' + (r.finish === 'error' ? ' rl-td-warn' : '') }, r.finish ?? '—'),
          ))),
        ),
      )
    }
    // ── 支持矩阵（设计 §3.4.3）──────────────────────────────────────────────
    const SEARCH_RESULT_LIMIT = 8
    const SEARCH_EMPTY_CANDIDATES = 20
    /** 目录声明 → 支持集合（无实测数据时用于 ✓ 与来源标注）。 */
    function declaredLevels(entry) {
      return asArray(entry !== null && entry !== undefined ? entry.efforts : null).filter((item) => LEVELS.includes(item))
    }
    /**
     * 单模型 × 7 档支持矩阵行。优先级与 computeImpact 一致
     * （probeEfforts 实测固化 > lastProbe working/rejected > 目录 efforts），但
     * ✗ 只标「实测拒绝」：某档未出现在实测可用集合里并不等于实测拒绝（可能被
     * blocked 或未测），无证据的档位一律 ?——开发原则 1（不编造）。
     */
    function supportMatrixRow(entry, probeEfforts, lastProbeModels) {
      const efforts = probeEfforts !== null && typeof probeEfforts === 'object' && !Array.isArray(probeEfforts) ? probeEfforts : {}
      const measured = measuredLevels(efforts[entry.key])
      const probedEntry = lastProbeModels[entry.key]
      const probedObject = probedEntry !== null && probedEntry !== undefined && typeof probedEntry === 'object' && !Array.isArray(probedEntry)
      const working = asArray(probedObject ? probedEntry.working : null).filter((item) => LEVELS.includes(item))
      const rejected = asArray(probedObject ? probedEntry.rejected : null).filter((item) => LEVELS.includes(item))
      const measuredWorking = measured !== null && measured.length > 0 ? measured : (working.length > 0 ? working : null)
      const measuredRejected = rejected.length > 0 ? rejected : null
      const declared = declaredLevels(entry)
      const cells = LEVELS.map((level) => {
        if (measuredWorking !== null && measuredWorking.includes(level)) return { level, state: 'yes', source: 'measured' }
        if (measuredRejected !== null && measuredRejected.includes(level)) return { level, state: 'no', source: 'measured' }
        if (measuredWorking !== null || measuredRejected !== null) return { level, state: 'unknown', source: 'unknown' }
        if (declared.includes(level)) return { level, state: 'yes', source: 'catalog' }
        return { level, state: 'unknown', source: 'unknown' }
      })
      return {
        key: entry.key,
        label: typeof entry.label === 'string' ? entry.label : entry.key,
        probed: measuredWorking !== null || measuredRejected !== null,
        supportCount: cells.filter((cell) => cell.state === 'yes').length,
        cells,
      }
    }
    /**
     * 支持矩阵（设计 §3.4.3）：默认折叠，标题带覆盖率摘要；行 = 模型，列 = 7 档，
     * 单元格 ✓/✗/?；排序 = 已探测在前 → 支持档数降序 → 键名升序。
     */
    function SupportMatrix(props) {
      const { t, lang, models, probeEfforts, lastProbe } = props
      const lastProbeModels = lastProbe !== null && lastProbe !== undefined && typeof lastProbe === 'object'
        && lastProbe.models !== null && typeof lastProbe.models === 'object' && !Array.isArray(lastProbe.models)
        ? lastProbe.models
        : {}
      const rows = asArray(models !== null && models !== undefined ? models.list : null)
        .map((entry) => supportMatrixRow(entry, probeEfforts, lastProbeModels))
      rows.sort((a, b) => {
        if (a.probed !== b.probed) return a.probed ? -1 : 1
        if (a.supportCount !== b.supportCount) return b.supportCount - a.supportCount
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)
      })
      const probedCount = rows.filter((row) => row.probed).length
      const cellTitle = (cell) => {
        if (cell.state === 'no') return t('supportSourceRejected')
        if (cell.state === 'yes') return cell.source === 'catalog' ? t('supportSourceCatalog') : t('supportSourceMeasured')
        return t('supportUnknown')
      }
      const headRow = el('tr', null,
        el('th', { className: 'rl-th', scope: 'col' }, t('model')),
        LEVELS.map((level) => el('th', { key: level, className: 'rl-th', scope: 'col' }, levelLabel(level, lang))))
      const bodyRows = rows.map((row) => el('tr', { key: row.key, 'data-matrix-model': row.key },
        el('td', { className: 'rl-td' }, row.label),
        row.cells.map((cell) => el('td', {
          key: cell.level,
          className: 'rl-td rl-matrix-cell rl-matrix-' + (cell.state === 'yes' ? 'yes' : (cell.state === 'no' ? 'no' : 'unknown')),
          title: cellTitle(cell),
          'aria-label': levelLabel(cell.level, lang) + ' ' + (cell.state === 'yes' ? t('supportYes') : (cell.state === 'no' ? t('supportNo') : t('supportUnknown'))),
        }, cell.state === 'yes' ? '✓' : (cell.state === 'no' ? '✗' : '?')))))
      const body = rows.length === 0
        ? el('div', { className: 'rl-muted-block' }, t('probeEmpty'))
        : el('div', { className: 'rl-matrix-wrap' },
            el('table', { className: 'rl-table rl-matrix-table' },
              el('thead', null, headRow),
              el('tbody', null, bodyRows)))
      return el(Disclosure, {
        summary: t('supportMatrix') + ' · ' + t('supportMatrixSummary', String(rows.length), String(probedCount), String(rows.length)),
      }, body)
    }
    // ── 模型级默认编辑器（按各模型实际支持的等级过滤，数据来自 llm.models 实时探测）──
    function ModelDefaults(props) {
      const { view, onChange, models, lastProbe } = props
      const t = props.t || zhT
      const lang = langOf(t)
      // 搜索框是唯一新增入口（设计 §3.4.1）：输入即过滤、点击即添加；精确的
      // provider/model 键即使不在目录里也可直接添加（保留原「任意 key」能力）。
      const [query, setQuery] = useState('')
      const configured = (view.value && view.value.models) || {}
      const entries = Object.entries(configured)
      const modelList = (models && models.list) || []
      const byKey = new Map(modelList.map((m) => [m.key, m]))
      // 等级排序权重（档位从低到高）
      const rank = (l) => { const i = LEVELS.indexOf(l); return i < 0 ? -1 : i }
      const highest = (efforts) => efforts.slice().sort((a, b) => rank(b) - rank(a))[0]

      const trimmed = query.trim()
      const lowered = trimmed.toLowerCase()
      const exact = trimmed !== '' ? byKey.get(trimmed) : undefined
      let matches = trimmed === ''
        // 空输入 = 前 20 条候选，保持目录的 provider 分组顺序（§3.4.1）
        ? modelList.slice(0, SEARCH_EMPTY_CANDIDATES)
        : modelList.filter((m) => m.key.toLowerCase().includes(lowered) || m.label.toLowerCase().includes(lowered))
      // 精确键必须可见：即使被过滤/截断也要给出可点击项（§3.4.1「可直接添加」）
      if (exact !== undefined && !matches.includes(exact)) matches = [exact].concat(matches)
      if (trimmed !== '') {
        matches = matches.slice().sort((a, b) => (a.key === trimmed ? -1 : (b.key === trimmed ? 1 : (a.key < b.key ? -1 : 1))))
      }
      matches = matches.slice(0, SEARCH_RESULT_LIMIT)
      const exactKeyForm = /^[^\s/]+\/[^\s/]+$/.test(trimmed)
      const arbitraryExact = exactKeyForm && exact === undefined && !matches.some((m) => m.key === trimmed)

      const addModel = (key) => {
        const normalized = typeof key === 'string' ? key.trim() : ''
        if (normalized === '') return
        const entry = byKey.get(normalized)
        const fallback = entry !== undefined && entry.efforts.length > 0 ? highest(entry.efforts) : 'high'
        // 写路径语义不变（§3.4.1）：仍是一次 models 深合并 patch。
        onChange({ models: { ...configured, [normalized]: fallback } })
        setQuery('')
      }
      const setLevel = (key, level) => {
        const next = { ...configured }
        next[key] = level
        onChange({ models: next })
      }
      const removeEntry = (key) => {
        onChange({ removeModelKey: key })
      }
      const optionLabel = (id) => levelLabel(id, lang) + ' (' + id + ')'
      // 搜索结果行：provider / model + 支持 chips（§3.4.1）
      const candidate = (entry) => el('button', {
        key: entry.key,
        type: 'button',
        role: 'option',
        'aria-selected': false,
        'data-model-key': entry.key,
        className: 'rl-search-item',
        onClick: () => addModel(entry.key),
      },
        el('span', { className: 'rl-search-item-main' }, entry.label),
        el('span', { className: 'rl-search-item-chips' },
          entry.efforts.length > 0
            ? entry.efforts.map((level) => el(LevelChip, { key: level, label: levelLabel(level, lang), variant: 'neutral' }))
            : el('span', { className: 'rl-muted' }, t('unknown'))))

      const rows = entries.map(([key, level]) => {
        const info = byKey.get(key)
        const efforts = info !== undefined && info.efforts.length > 0 ? info.efforts : LEVELS
        const supported = efforts.includes(level)
        const options = efforts.map((item) =>
          el('option', { key: item, value: item }, optionLabel(item)))
        if (!supported) {
          // 已配置等级不在该模型支持列表：保留当前值并明示“运行时将跳过”
          options.push(el('option', { key: '__current', value: level }, optionLabel(level) + t('unsupportedOpt')))
        }
        return el('tr', { key },
          el('td', { className: 'rl-td' },
            el('div', null, key),
            el('div', { className: 'rl-cell-sub' },
              info !== undefined && info.efforts.length > 0
                ? [el('span', { key: '__supports', className: 'rl-muted' }, t('supports'))].concat(
                    efforts.map((item) => el(LevelChip, { key: item, label: levelLabel(item, lang), variant: item === level ? 'primary' : 'neutral' })),
                    supported ? [] : [el(LevelChip, { key: '__current', label: levelLabel(level, lang) + ' ⚠', variant: 'warning' })])
                : el('span', { className: 'rl-muted' }, t('unknown')))),
          el('td', { className: 'rl-td' },
            el('select', {
              value: level,
              onChange: (event) => setLevel(key, event.target.value),
              className: 'rl-select' + (!supported ? ' rl-select-warn' : ''),
              'aria-label': t('colDefaultLevel') + ' ' + key,
            }, options)),
          el('td', { className: 'rl-td rl-td-nowrap' },
            el(Button, { variant: 'danger', onClick: () => removeEntry(key) }, t('delete'))),
        )
      })

      return el('div', null,
        el('div', { className: 'rl-field' },
          el('div', { className: 'rl-field-label' }, t('addModel')),
          el(SearchField, {
            value: query,
            onChange: setQuery,
            placeholder: t('searchModel'),
            label: t('searchModel'),
            disabled: models === null,
          }),
          el('div', { className: 'rl-field-hint' }, t('searchExactKey')),
          models === null
            ? el('div', { className: 'rl-muted-block' }, t('loadModels'))
            : el('div', { className: 'rl-search-wrap' },
                matches.length > 0
                  ? el('div', { className: 'rl-search-list', role: 'listbox', 'aria-label': t('searchModel') }, matches.map(candidate))
                  : null,
                arbitraryExact
                  ? el('div', { className: 'rl-search-exact' },
                      el(Button, { variant: 'primary', size: 'sm', onClick: () => addModel(trimmed) }, t('add') + ': ' + trimmed))
                  : null,
                trimmed !== '' && matches.length === 0 && !arbitraryExact
                  ? el('div', { className: 'rl-muted-block' }, t('searchEmpty'))
                  : (trimmed === '' && modelList.length === 0
                      ? el('div', { className: 'rl-muted-block' }, t('searchEmpty'))
                      : null),
                exact !== undefined && exact.efforts.length > 0
                  ? el('div', { className: 'rl-muted-block' }, t('addHint', exact.efforts.join('/'), levelLabel(highest(exact.efforts), lang)))
                  : null)),
        entries.length === 0
          ? el('div', { className: 'rl-hint' }, t('noModels'))
          : el('table', { className: 'rl-table' },
              el('thead', null, el('tr', null,
                el('th', { className: 'rl-th', scope: 'col' }, t('colModelCap')),
                el('th', { className: 'rl-th', scope: 'col' }, t('colDefaultLevel')),
                el('th', { className: 'rl-th', scope: 'col' }, t('colActions')),
              )),
              el('tbody', null, rows),
            ),
        // 支持矩阵（§3.4.3）：默认折叠；数据源 = view.probeEfforts + stats.lastProbe + 目录
        el(SupportMatrix, {
          t,
          lang,
          models,
          probeEfforts: view.value ? view.value.probeEfforts : undefined,
          lastProbe,
        }),
        el(Disclosure, { summary: t('prioritySummary') },
          el('div', { className: 'rl-hint' }, t('modelCapNote'), t('priority'))),
      )
    }
    // ── purpose 级默认（compaction / session-title 独立等级）──────────────
    function PurposeDefaults(props) {
      const { view, onChange } = props
      const t = props.t || zhT
      const lang = langOf(t)
      const purposes = (view.value && view.value.purposes) || {}
      const setPurpose = (key, level) => {
        const next = { ...purposes }
        if (level === 'follow') delete next[key]
        else next[key] = level
        onChange({ purposes: next })
      }
      const row = (key, label) => {
        const current = purposes[key]
        return el('div', { className: 'rl-field-row', key },
          el('span', { className: 'rl-field-row-label' }, label),
          el('select', {
            value: current !== undefined ? current : 'follow',
            onChange: (event) => setPurpose(key, event.target.value),
            className: 'rl-select',
            'aria-label': label,
          }, ['follow', ...LEVELS].map((item) =>
            el('option', { key: item, value: item }, levelLabel(item, lang)))),
          current !== undefined
            ? el('span', { className: 'rl-muted' }, t('purposeActive', label))
            : null,
        )
      }
      return el('div', null,
        row('compaction', t('purposeCompaction')),
        row('session-title', t('purposeTitle')),
        el('div', { className: 'rl-hint' }, t('purposeHint')),
      )
    }
    // ── 页面骨架（规范 §3）────────────────────────────────────────────────
    function fmtCount(n) {
      const value = typeof n === 'number' && Number.isFinite(n) ? n : 0
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    /** ① 页头（§3.1）：标题/价值主张 + 状态胶囊组 + 主操作（探测按钮从观测卡上移）。 */
    function PageHeader(props) {
      const { t, lang, enabled, level, summary, contractWarn, probe } = props
      const routes = summary !== null ? String(summary.routes.length) : '—'
      const models = summary !== null ? String(summary.models) : '—'
      return el('header', { className: 'rl-header' },
        el('div', { className: 'rl-header-main' },
          el('div', null,
            el('h2', { className: 'rl-header-title' }, t('title')),
            el('p', { className: 'rl-header-sub' }, t('pageSubtitle'))),
          el('div', { className: 'rl-header-actions' },
            el(Button, {
              variant: 'primary',
              disabled: probe.probing || probe.targets.length === 0,
              onClick: probe.probeAll,
            }, probe.probing ? t('testing') : t('probeAll')),
            probe.probing && probe.progress !== ''
              ? el('div', {
                  className: 'rl-progress-text',
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': probe.progressTotal,
                  'aria-valuenow': probe.progressIndex,
                  'aria-label': probe.progress,
                }, probe.progress)
              : null)),
        el('div', { className: 'rl-pills' },
          el(StatusPill, { variant: enabled ? 'ok' : 'muted' }, enabled ? t('statusEnabled') : t('statusDisabled')),
          el(StatusPill, { variant: 'primary' }, t('statusDefault', levelLabel(level, lang))),
          el(StatusPill, { variant: 'muted' }, t('statusScope', routes, models)),
          contractWarn !== '' ? el(StatusPill, { variant: 'bad', title: contractWarn }, t('statusDegraded')) : null))
    }

    /** ② 概览（§3.2）：4 个 StatTile；数据缺失时保持中性占位，不把整页变成 loading。 */
    function Overview(props) {
      const { t, lang, level, summary, stats } = props
      const hint = levelHint(level, lang)
      const activeIndex = LEVELS.indexOf(level)
      const routeCount = summary !== null ? summary.routes.length : null
      const modelCount = summary !== null ? summary.models : null
      const pending = summary !== null ? summary.routes.filter((route) => route.level !== level).length : 0
      const totalCalls = stats !== null ? (stats.totalCalls ?? 0) : null
      const since = stats !== null && typeof stats.since === 'number' ? fmtTime(stats.since) : ''
      const aggregates = stats !== null ? Object.values(stats.models ?? {}) : []
      const reporting = aggregates.filter((agg) => typeof agg.reasoningTokens === 'number' && agg.reasoningTokens > 0).length
      const thinkingTotal = aggregates.reduce((sum, agg) => sum + (typeof agg.reasoningTokens === 'number' ? agg.reasoningTokens : 0), 0)
      return el('div', { className: 'rl-stats-grid' },
        el(StatTile, {
          label: t('tileLevel'),
          value: levelLabel(level, lang),
          sub: hint !== undefined ? hint.meaning : undefined,
          title: hint !== undefined ? hint.scenario : undefined,
        }, el('div', { className: 'rl-scale', 'aria-hidden': 'true' },
          LEVELS.map((item, index) => el('span', {
            key: item,
            className: 'rl-scale-seg' + (index <= activeIndex ? ' rl-scale-seg-on' : ''),
          })))),
        el(StatTile, {
          label: t('tileScope'),
          value: routeCount !== null ? t('scopeValue', String(routeCount), String(modelCount)) : t('summarizing'),
          sub: pending > 0 ? t('scopePending', String(pending)) : undefined,
          tone: pending > 0 ? 'warn' : undefined,
        }),
        el(StatTile, {
          label: t('tileCalls'),
          value: totalCalls !== null ? fmtCount(totalCalls) : '—',
          sub: since !== '' ? t('tileCallsSince', since) : t('summarizing'),
        }),
        el(StatTile, {
          label: t('tileThinking'),
          // stats 未到时不要提前断言「不可观测」——那是数据结论，不是加载态。
          value: stats === null ? '—' : (thinkingTotal > 0 ? fmtTokens(thinkingTotal) + ' tok' : t('tileThinkingUnknown')),
          sub: stats !== null ? t('tileThinkingCoverage', String(reporting), String(aggregates.length)) : t('summarizing'),
        }))
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function ReasoningPage(props) {
      // 首帧也注入一次：apply 在宿主启动时可能早于 document.head 就绪，且 HMR
      // 重挂载会保留模块闭包而重建页面——ensureStyles 幂等，重复调用无副作用。
      ensureStyles()
      const api = props.api
      const t = props.t || zhT
      const lang = langOf(t)
      const [view, setView] = useState(null) // llm-reasoning namespace view
      const [summary, setSummary] = useState(null)
      const [busy, setBusy] = useState(false)
      // 单一 toast（设计 §5.1）：成功 = 「已保存」+「撤销」（3s 自动消失）；失败 = 红。
      // 旧 notice 曾在 loading 态与页尾两处渲染，重构后只保留这一条通道。
      const [toast, setToast] = useState(null)
      // 统计轮询暂停（设计 §3.6.1/§5.3）：只停 2s 轮询，不影响「最近调用」等渲染。
      const [paused, setPaused] = useState(false)
      const toastTimer = useRef(0)
      // R0-P2-3：撤销删除模型默认时写回的是「撤销时刻」的 models（而非点击删除时的
      // 旧快照）——ref 每次 render 后同步，toast 的 onAction 闭包读到的永远是最新值。
      const viewRef = useRef(null)
      useEffect(() => { viewRef.current = view })
      // 页面级共享目录（§3.3/§3.4）：ModelDefaults 与影响预览消费同一份 llm.models，
      // 避免两个消费者各自发一次 modelCatalog RPC；null = 尚未加载（ModelDefaults
      // 仍显示原「加载模型列表」文案）。
      const [catalog, setCatalog] = useState(null)
      const [stats, setStats] = useState(null)
      const [statsFailed, setStatsFailed] = useState(false)
      const [contractWarn, setContractWarn] = useState('')

      /** 统一 toast 通道：自动清理上一枚 3s 定时器；dismissMs 仅成功类使用。 */
      const showToast = (next) => {
        if (toastTimer.current !== 0) {
          if (typeof window !== 'undefined' && window !== null && typeof window.clearTimeout === 'function') window.clearTimeout(toastTimer.current)
          toastTimer.current = 0
        }
        setToast(next === undefined ? null : next)
        if (next !== null && next !== undefined && typeof next.dismissMs === 'number' && next.dismissMs > 0
          && typeof window !== 'undefined' && window !== null && typeof window.setTimeout === 'function') {
          toastTimer.current = window.setTimeout(() => {
            toastTimer.current = 0
            setToast(null)
          }, next.dismissMs)
        }
      }
      useEffect(() => () => {
        if (toastTimer.current !== 0 && typeof window !== 'undefined' && window !== null && typeof window.clearTimeout === 'function') window.clearTimeout(toastTimer.current)
        toastTimer.current = 0
      }, [])

      const refresh = () => {
        api.settings.describe({}).then((response) => {
          if (!response.result.ok) {
            showToast({ message: t('readFail', (response.result.error && response.result.error.message) || t('unknownErr')), kind: 'bad' })
            return
          }
          const namespaces = (response.result.value && response.result.value.namespaces) || []
          // R-1（REVIEW-FEAT-001-R1）：ns 值改读镜像段（HOST_REMOTE_CONTRACT.namespaces =
          // HOST_NAMESPACES 镜像），值逐字节等值零行为变更——两平面一致性由单源测试锚定。
          const rl = namespaces.find((entry) => entry.ns === HOST_REMOTE_CONTRACT.namespaces.self)
          const pi = namespaces.find((entry) => entry.ns === HOST_REMOTE_CONTRACT.namespaces.piAi)
          const ds = namespaces.find((entry) => entry.ns === HOST_REMOTE_CONTRACT.namespaces.deepseek)
          setView(rl || null)
          // 028-F2：路由默认按「值」收集——存在性计数会把陈旧值也计成「已应用」，
          // 掩盖路由当前值 ≠ 全局目标的失配（RCA §2.1/:743-744）
          const routeItems = []
          let models = 0
          const providers = pi && pi.value && pi.value.providers ? pi.value.providers : {}
          for (const [name, profile] of Object.entries(providers)) {
            if (profile.reasoning !== undefined) routeItems.push({ name, level: profile.reasoning })
            if (Array.isArray(profile.models)) {
              for (const model of profile.models) {
                if (model.reasoningEfforts !== undefined) models += 1
              }
            }
          }
          setSummary({
            routes: routeItems,
            models,
            // FEAT-004（设计 §10.1）：provider 名集合是 persisted 三态判定的唯一事实源
            piAiProviders: Object.keys(providers),
            deepseek: ds && ds.value ? (ds.value.reasoningEffort === undefined ? null : ds.value.reasoningEffort) : null,
          })
        }).catch((error) => {
          // MAINT-022 R0-F1：适配层 fail-loud 的结构化错误文本（宿主命名空间缺失
          // 等）直入页面——不再吞成无差别「读取状态失败」，用户可据此报告版本组合。
          showToast({ message: t('readFail', (error && error.message) || t('unknownErr')), kind: 'bad' })
        })
      }

      useEffect(() => { refresh() }, [])

      useEffect(() => {
        // llm.models 一次返回全部 provider 的分组目录（运行时从各 adapter 实时解析）：
        // {groups: [{id, name, models: [{id, name, reasoning?: {efforts: [{id}], defaultEffort?}}]}], failures: []}
        // 上提到页面后 ModelDefaults 不再自取——它只是把同一份目录映射成下拉/能力 chips。
        let alive = true
        api.llm.models({}).then((response) => {
          if (!alive) return
          if (!response || !response.result || !response.result.ok) {
            setCatalog({ list: [], grouped: [], groups: [] })
            return
          }
          const groups = (response.result.value && response.result.value.groups) || []
          const list = []
          const grouped = []
          for (const group of groups) {
            if (typeof group.id !== 'string') continue
            const groupModels = []
            for (const model of group.models ?? []) {
              if (typeof model.id !== 'string' || model.id === '') continue
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
          setCatalog({ list, grouped, groups })
        }).catch(() => { if (alive) setCatalog({ list: [], grouped: [], groups: [] }) })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        let alive = true
        const tick = () => {
          fetch('/reasoning-level-stats', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
            .then((data) => {
              if (!alive) return
              setStats(data)
              setStatsFailed(false)
              // MAINT-036：契约自检结果 → 页头「功能降级」胶囊（静默失效 → 可见降级）
              const ch = data !== null && typeof data === 'object' ? data.contractHealth : undefined
              setContractWarn(ch !== null && ch !== undefined && ch.ok === false
                ? t('hostContractWarn', Array.isArray(ch.missing) ? ch.missing.join(', ') : '')
                : '')
            })
            .catch(() => { if (alive) setStatsFailed(true) })
        }
        // 暂停 = 不建 interval、不发请求（保留已有 stats 快照继续渲染）；
        // 恢复时本 effect 因 paused 变化重跑 → 先 tick() 立即拉一次（设计 §5.3）。
        if (paused === true) return () => { alive = false }
        tick()
        const timer = window.setInterval(tick, 2000)
        return () => { alive = false; if (timer) window.clearInterval(timer) }
      }, [paused])

      // 探测目标 = 全部可调用模型；跳过 id 以 '-router' 结尾的组（疑似路由包装组：能力与
      // 底层路由一致，避免重复实测烧请求）。该命名约定未能在本地 DSH 安装树确证——本环境中
      // 未发现任何以 '-router' 结尾的模型组 id（仅有插件/命名空间 id，如 dsh-agent-router、
      // vision-router）；属未证实的启发式，按观察保留，待上游/真实部署确认后再收紧或放宽。
      const probeTargets = []
      for (const group of (catalog !== null ? catalog.groups : []) || []) {
        if (typeof group.id !== 'string' || group.id.endsWith('-router')) continue
        for (const model of group.models ?? []) {
          if (typeof model.id !== 'string' || model.id === '') continue
          probeTargets.push({ provider: group.id, model: model.id, key: group.id + '/' + model.id })
        }
      }
      const probe = useProbe({ t, targets: probeTargets, stats })

      /**
       * 撤销计划（设计 §5.1 + §10.3）：记录本次写入涉及键的旧值，撤销 = 反向写。
       * 关键事实：宿主 settings.update 是 mergeLayers 深合并（@deepseek-ai/dsh-settings
       * lib/index.js:281-290）——「新增的键」无法靠回写旧对象删除，所以 models /
       * purposes 按差集拆成 {patch: 回写旧值, ops: 删除新增键}；删除模型默认（unset）
       * 的撤销按 §10.3 明确为 update 写回被删的 { [key]: oldLevel }——R0-P2-3 起只记录
       * 该键（restoreModelKey），写回时以撤销时刻的最新 models 为基线，不回写旧快照。
       * 仅保留一层撤销：每次 change 都会覆盖上一枚 toast，撤销点随之更新。
       */
      const undoPlanFor = (patch, currentValue) => {
        const current = currentValue !== null && typeof currentValue === 'object' ? currentValue : {}
        const previousModels = current.models !== null && typeof current.models === 'object' && !Array.isArray(current.models) ? current.models : {}
        if (patch.removeModelKey !== undefined) {
          const key = patch.removeModelKey
          // R0-P2-3（设计 §10.3）：只记录被删的 {key, level}；写回在 runUndo 内按
          // 「撤销时刻」的最新 models 构造，不得回写点击删除时的旧整张快照——否则
          // 3s 窗口内其他标签页/外部写者对**别的**模型的改动会被静默回滚。
          return {
            restoreModelKey: { key, level: typeof previousModels[key] === 'string' ? previousModels[key] : 'high' },
            patch: null,
            ops: [],
          }
        }
        const ops = []
        const restore = {}
        const collectDiff = (previous, next, parentKey) => {
          for (const key of Object.keys(next)) {
            if (Object.prototype.hasOwnProperty.call(previous, key)) {
              if (previous[key] !== next[key]) {
                if (restore[parentKey] === undefined) restore[parentKey] = {}
                restore[parentKey][key] = previous[key]
              }
            } else {
              ops.push({ op: 'unset', path: [parentKey, key] })
            }
          }
          for (const key of Object.keys(previous)) {
            if (!Object.prototype.hasOwnProperty.call(next, key)) {
              if (restore[parentKey] === undefined) restore[parentKey] = {}
              restore[parentKey][key] = previous[key]
            }
          }
        }
        if (patch.models !== undefined && patch.models !== null && typeof patch.models === 'object' && !Array.isArray(patch.models)) {
          collectDiff(previousModels, patch.models, 'models')
        }
        if (patch.purposes !== undefined && patch.purposes !== null && typeof patch.purposes === 'object' && !Array.isArray(patch.purposes)) {
          const previousPurposes = current.purposes !== null && typeof current.purposes === 'object' && !Array.isArray(current.purposes) ? current.purposes : {}
          collectDiff(previousPurposes, patch.purposes, 'purposes')
        }
        // 标量开关/等级：回写「当前生效值」（缺省即默认，避免把 undefined 写进 schema）
        if (patch.enabled !== undefined) restore.enabled = current.enabled !== false
        if (patch.level !== undefined) restore.level = LEVELS.includes(current.level) ? current.level : 'high'
        if (patch.syncDefaultAgent !== undefined) restore.syncDefaultAgent = current.syncDefaultAgent === true
        if (Object.keys(restore).length === 0 && ops.length === 0) return null
        return { patch: Object.keys(restore).length > 0 ? restore : null, ops }
      }
      /** 执行反向写；成功绿 toast，失败红 toast（saveFail，不静默）。 */
      const runUndo = (plan) => {
        if (plan === null || plan === undefined) return
        setBusy(true)
        showToast(null)
        const ns = HOST_REMOTE_CONTRACT.namespaces.self
        let patch = plan.patch !== null && plan.patch !== undefined ? plan.patch : null
        let overwroteExisting = false
        if (plan.restoreModelKey !== undefined) {
          const key = plan.restoreModelKey.key
          const oldLevel = plan.restoreModelKey.level
          // R0-P2-3：唯一写回 = 被删的 {key: oldLevel}；其余键取撤销时刻的最新
          // view.value.models（同值写入 = 无变化），不回滚他人写入。
          const latestView = viewRef.current
          const latestValue = latestView !== null && latestView !== undefined && typeof latestView === 'object' ? latestView.value : undefined
          const currentModels = latestValue !== null && latestValue !== undefined && typeof latestValue === 'object'
            && latestValue.models !== null && typeof latestValue.models === 'object' && !Array.isArray(latestValue.models)
            ? latestValue.models
            : {}
          // 该 key 已被他人重新添加 → 本键直接覆盖为原值（其余键仍按当前值写）。
          overwroteExisting = Object.prototype.hasOwnProperty.call(currentModels, key)
          patch = { models: { ...currentModels, [key]: oldLevel } }
        }
        const steps = []
        if (patch !== null) steps.push(() => api.settings.update({ ns, patch }))
        if (Array.isArray(plan.ops) && plan.ops.length > 0) steps.push(() => api.settings.mutate({ ns, ops: plan.ops }))
        steps.reduce((chain, step) => chain.then(() => step().then((response) => {
          if (!response || !response.result || response.result.ok !== true) {
            const error = response && response.result ? response.result.error : undefined
            throw new Error((error && error.message) || t('unknownErr'))
          }
        })), Promise.resolve())
          .then(() => {
            refresh()
            showToast({
              message: overwroteExisting ? t('undoRestoredOverride') : t('undoSucceeded'),
              kind: 'ok',
              dismissMs: 3000,
            })
          })
          .catch((error) => {
            showToast({ message: t('saveFail', (error && error.message) || t('unknownErr')), kind: 'bad' })
          })
          .then(() => setBusy(false))
      }

      const change = (patch) => {
        const undo = view !== null ? undoPlanFor(patch, view.value || {}) : null
        const ns = HOST_REMOTE_CONTRACT.namespaces.self
        setBusy(true)
        showToast(null)
        // 删除模型级默认：update 是深合并（无法删键），改走 mutate unset
        // （ns 改读镜像段 namespaces.self——R-1，值等值零行为变更）
        const call = patch.removeModelKey !== undefined
          ? api.settings.mutate({ ns, ops: [{ op: 'unset', path: ['models', patch.removeModelKey] }] })
          : api.settings.update({ ns, patch })
        call.then((response) => {
          if (!response.result.ok) {
            showToast({ message: t('saveFail', (response.result.error && response.result.error.message) || t('unknownErr')), kind: 'bad' })
          } else {
            refresh()
            showToast({
              message: t('savedNotice'),
              kind: 'ok',
              actionLabel: undo !== null ? t('undoAction') : undefined,
              onAction: undo !== null ? () => runUndo(undo) : undefined,
              dismissMs: 3000,
            })
          }
        }).catch(() => { showToast({ message: t('saveFailShort'), kind: 'bad' }) }).then(() => setBusy(false))
      }

      // MAINT-022 R0-F1：数据面失败（describe 信封 ok:false / 适配层 fail-loud）
      // 时 view 恒 null——错误提示必须在 loading 态渲染，否则页面永远停在
      // 「加载中…」（审查实测证伪的原实现：notice 只在 loaded 视图渲染）。
      // 全页仅此一处 Toast（重构后不再有第二处 notice 渲染点）。
      if (view === null) {
        return el('div', { className: 'rl-root rl-page' },
          toast !== null
            ? el(Toast, { message: toast.message, kind: toast.kind, actionLabel: toast.actionLabel, onAction: toast.onAction })
            : el('div', { className: 'rl-loading' }, t('loading')))
      }

      const value = view.value || {}
      const enabled = value.enabled !== false
      const level = LEVELS.includes(value.level) ? value.level : 'high'
      const deepseekText = summary === null || summary.deepseek === null
        ? t('dsUnset')
        : t('dsSet', levelLabel(summary.deepseek, lang))
      // 028-F2：值核对——路由当前值 ≠ 全局目标时如实警示（warning 色 + ≠全局标注）
      const routeList = summary !== null && Array.isArray(summary.routes) ? summary.routes : []
      const mismatched = routeList.length > 0 && routeList.some((r) => r.level !== level)
      const routesText = summary === null
        ? ''
        : (routeList.length === 0
            ? t('zeroRoutes')
            : routeList.map((r) => r.level === level
                ? t('routeItem', r.name, levelLabel(r.level, lang))
                : t('routeItemMismatch', r.name, levelLabel(r.level, lang), levelLabel(level, lang))).join(t('semiSep')))
      const appliedText = summary === null
        ? t('summarizing')
        : t('appliedSummary', routesText, String(summary.models), deepseekText)
      const impact = computeImpact({
        level,
        catalog,
        probeEfforts: value.probeEfforts,
        lastProbe: stats !== null && typeof stats === 'object' ? stats.lastProbe : undefined,
      })

      return el('div', { className: 'rl-root rl-page' },
        el(PageHeader, {
          t,
          lang,
          enabled,
          level,
          summary,
          contractWarn,
          probe,
        }),
        el(Overview, { t, lang, level, summary, stats }),
        el('div', { className: 'rl-split' },
          el(Card, { title: t('globalSettings') },
            el(Switch, {
              checked: enabled,
              disabled: busy,
              onChange: (next) => change({ enabled: next }),
              label: t('enable'),
              hint: enabled ? t('switchOnHint') : t('switchOffHint'),
            }),
            el('div', { className: 'rl-field' },
              el('div', { className: 'rl-field-label' }, t('level')),
              el(SegmentedControl, {
                t,
                lang,
                value: level,
                disabled: busy || !enabled,
                onChange: (next) => change({ level: next }),
                warnLevel: impact.noKnownSupport ? level : undefined,
              }),
              catalog === null
                ? el('div', { className: 'rl-muted-block' }, t('loading'))
                : el(ImpactPreview, { t, lang, level, impact }),
              // R0-P2-5（设计 §10.2）：off 档计费边界必须在页面上可见（不只藏在 title）。
              level === 'off' ? el('div', { className: 'rl-hint' }, t('offBillingNote')) : null),
            el(Switch, {
              checked: value.syncDefaultAgent === true,
              disabled: busy || !enabled,
              onChange: (next) => change({ syncDefaultAgent: next }),
              label: t('syncAgent'),
              hint: t('syncAgentHint'),
            }),
            // 028-F2 的逐路由明细保留在全局卡底部：页头胶囊只给计数，失配原因仍需
            // 用户可读的「哪条路由 = 什么等级、≠ 全局什么」。
            el('div', { className: 'rl-applied' + (mismatched ? ' rl-applied-warn' : '') }, appliedText)),
          el(Card, { title: t('purposeLevels') },
            el(PurposeDefaults, { view, onChange: change, t }))),
        el(Card, { title: t('modelDefaults') },
          el(ModelDefaults, {
            view,
            onChange: change,
            models: catalog,
            lastProbe: stats !== null && typeof stats === 'object' ? stats.lastProbe : undefined,
            t,
          })),
        el(StatsPanel, {
          stats,
          statsFailed,
          probe,
          t,
          // FEAT-004（§10.1）：persisted 三态判定要 provider 名集合（describe 实测值）
          piAiProviders: summary !== null && Array.isArray(summary.piAiProviders) ? summary.piAiProviders : [],
          paused,
          onTogglePause: () => setPaused((previous) => previous !== true),
        }),
        el(Disclosure, { summary: t('hintSummary') },
          el('div', { className: 'rl-hint' },
            t('pageHintMain'),
            t('pageHintRoute'),
            t('statsHint'))),
        toast !== null
          ? el(Toast, { message: toast.message, kind: toast.kind, actionLabel: toast.actionLabel, onAction: toast.onAction })
          : null,
      )
    }

    // ── host-compat 客户端镜像段（SINGLE-SOURCE-MIRROR）────────────────────────
    // 与 lib/host-compat.js 的 HOST_REMOTE_CONTRACT 同源；由
    // test/host-compat-single-source.test.mjs 加载两平面真实工件 deep-equal 锚定，
    // 任何一侧漂移即 CI 红。本段只允许数据字面量，禁止逻辑。dsh 升级时与
    // host-compat.js 同一变更单元内同步修改（FEAT-001，设计 §3.3 方案 A——
    // 宿主 makeRequire 无文件系统解析，客户端无法 require 共享模块，只能镜像）。
    // 本段必须留在 client.js 工厂内（cordis 入口契约：inject 从入口导出）。
    const HOST_REMOTE_CONTRACT = {
      faces: { settings: 'remote.settings', session: 'remote.session' },
      clientInject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.session'],
      namespaces: { self: 'llm-reasoning', deepseek: 'llm-deepseek', piAi: 'llm-pi-ai', agentDefaultModel: 'agent-default-model' },
      methods: {
        'settings.describe': { arity: 0, params: [] },
        'settings.update': { arity: 3, params: ['ns', 'patch', 'expectedRevision'], thirdParamAcceptsUndefined: true },
        'settings.replace': { arity: 3, params: ['ns', 'section', 'expectedRevision'], thirdParamAcceptsUndefined: true },
        'settings.mutate': { arity: 3, params: ['ns', 'ops', 'expectedRevision'], thirdParamAcceptsUndefined: true, opShapes: ['set', 'unset'] },
        'session.modelCatalog': { arity: 0, params: [] },
      },
      responseEnvelope: 'direct:{ok,value|error}',
      legacyEnvelope: '{result:{ok,value|error}}',
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
    //    （describe/update/replace/mutate——位置参数 + {ok, value|error} 直面）+
    //    remote.session.modelCatalog（ModelCatalog.groups 形状与旧
    //    api.llm.models 的 groups 一致）。官方消费先例：
    //    dsh-client-ui-settings-models 静态 inject remote.credentials/llm/settings。
    //  · MAINT-025 元数契约（根因报告 docs/retro/rca-MAINT-025.md——本文件
    //    曾漏第三参，每次设置写入被宿主网关元数守卫确定性拒绝）：describe/
    //    modelCatalog 零参；update/mutate/replace 三参（ns, patch/ops/section,
    //    expectedRevision）——第三参必须占位（.d.ts 为 number|undefined，非
    //    optional），值可 undefined（宿主文档化语义 "undefined writes
    //    unconditionally"，事实源 dsh-api-settings-controller lib/index.js）。
    //    客户端网关在 RPC 发起前严格校验元数（dsh-api-gateway lib/client.js
    //    元数守卫段，values.length !== parameters.length 即 throw）——任何转发
    //    改动先跑判别测试 test/host-face-contract.test.mjs（真实宿主工件判别）。
    //  · MAINT-035（0.2.0-rc.2 复核，消费面零改动）：describe RPC result 实证
    //    形状 = {writable, hasDocument, namespaces:[描述符]}（dsh-api-remotes
    //    settings describe result schema）——页面消费 response.result.value.
    //    namespaces 包装不变；描述符字段为超集（ns/schema/revision/value/base/
    //    user/autoGenerate/applies——新增字段透传无碍），rl/pi/ds 消费点
    //    （.value.providers、.value.reasoningEffort 路径）不变。
    // 本适配层把新面收敛成页面既有消费面（旧信封 {result:{ok,value?,error?}}），
    // 页面/组件消费点零改动；调用时惰性解析 ctx.get('remote.*')（服务重挂后取
    // 最新，不缓存旧引用）；命名空间缺失 = 宿主版本不兼容 → fail-loud（结构化
    // 错误进页面「读取失败」行，禁裸 TypeError 击穿面板——P8，先例 FIX-028）。
    function hostApiFace(ctx) {
      const faceOf = (name) => {
        const viaGet = ctx.get(HOST_REMOTE_CONTRACT.faces[name])
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
            // MAINT-025 F1：三参元数契约——expectedRevision 必须占位（值可
            // undefined = 无条件写入；2 参转发会被宿主网关元数守卫拒绝）。
            return envelopeOf(await requireSettings().update(input.ns, input.patch, input.expectedRevision))
          },
          mutate: async (payload) => {
            const input = payload && typeof payload === 'object' ? payload : {}
            return envelopeOf(await requireSettings().mutate(input.ns, Array.isArray(input.ops) ? input.ops : [], input.expectedRevision))
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

    // C2 触点单一事实位：镜像段的 clientInject 拷贝（拷贝而非引用，防外部变更）。
    const inject = [...HOST_REMOTE_CONTRACT.clientInject]

    function apply(ctx) {
      // 样式只注入一次；页面首帧再调（见 ReasoningPage）覆盖 HMR/重挂载。
      ensureStyles()
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
