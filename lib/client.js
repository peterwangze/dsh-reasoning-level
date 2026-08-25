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
 * wire 面：settings 域（describe/update）+ llm 域（providers/models）+ 直连 stats 端点。
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

    // ── 轻量 i18n：zh/en 双字典，缺省 zh ──────────────────────────────
    const LANG = {
      zh: {
        enable: '启用统一默认推理等级',
        level: '默认推理等级（全局）',
        syncAgent: '同步默认 agent 模型等级',
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
        time: '时间', effort: '推理等级', duration: '耗时', result: '结果',
        blacklist: '⚠ 实测黑名单：', since: '自', totalCalls: '共', callsSuffix: '次调用（每 2s 刷新）',
        errHigh: (n) => `错误率 ${n}% 偏高，建议降低等级`,
        rejectSug: (rej, hi) => `实测拒绝 ${rej.join('/')}，建议用最高档 ${hi ?? '（默认）'}`,
        supports: '支持：', unknown: '能力未知', noLevel: '（无推理等级）',
        testOk: (t, l, d) => `✓ ${t} · ${l} 可用（${d}ms）`,
        testFail: (t, l, e) => `✗ ${t} · ${l} 不可用${e ? '：' + e : ''}`,
        blacklisted: '（已入黑名单）',
        probeAll: '一键探测全部模型并固化配置',
        probing: (i, n, k) => `探测中 ${i}/${n}：${k}`,
        probeDone: (n, w) => `探测完成：${n} 个模型，固化 ${w} 处模型能力声明；实测拒绝的等级仅作为该次探测结果（不入黑名单），运行时自愈（真实调用失败会临时跳过该档，重启即清零）。`,
        probeEmpty: '没有可探测的模型（模型列表加载失败或为空）。',
        probeFail: '探测请求失败',
        probeApplyFail: '固化配置失败',
        probeColModel: '模型', probeColWorking: '实测可用等级', probeColRejected: '实测拒绝', probeColBlocked: '其他错误',
        probeLabel: '实测探测',
        probeResultsTitle: '探测结果',
        probeFooter: (n) => `（${n} 个模型 · 实测用 1-token 请求）`,
        probeNote: '探测拒绝不入黑名单、不持久化；运行时自愈——真实调用被网关拒绝后临时跳过该档（仅当前会话生效）。可用的等级写回该模型能力声明（手写声明自动并入新档位）。',
      },
      en: {
        enable: 'Enable unified default reasoning level',
        level: 'Default level (global)',
        syncAgent: 'Sync default agent model level',
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
        time: 'Time', effort: 'Effort', duration: 'Duration', result: 'Result',
        blacklist: '⚠ Blacklist: ', since: 'Since', totalCalls: 'total', callsSuffix: 'calls (2s refresh)',
        errHigh: (n) => `Error rate ${n}% high, consider lowering level`,
        rejectSug: (rej, hi) => `Rejected ${rej.join('/')} in practice, use highest ${hi ?? '(default)'}`,
        supports: 'Supports: ', unknown: 'capability unknown', noLevel: '(no reasoning level)',
        testOk: (t, l, d) => `✓ ${t} · ${l} OK (${d}ms)`,
        testFail: (t, l, e) => `✗ ${t} · ${l} failed${e ? ': ' + e : ''}`,
        blacklisted: ' (blacklisted)',
        probeAll: 'Probe all models & fix config',
        probing: (i, n, k) => `Probing ${i}/${n}: ${k}`,
        probeDone: (n, w) => `Probe complete: ${n} models, ${w} capability declarations updated; rejected levels are probe-only (not blacklisted), runtime self-healing (real failures skip the level for this session, resets on restart).`,
        probeEmpty: 'No models to probe (model list missing or empty).',
        probeFail: 'Probe request failed',
        probeApplyFail: 'Apply failed',
        probeColModel: 'Model', probeColWorking: 'Working levels', probeColRejected: 'Rejected', probeColBlocked: 'Other errors',
        probeLabel: 'Probe & fix',
        probeResultsTitle: 'Probe results',
        probeFooter: (n) => `(${n} models · 1-token requests)`,
        probeNote: 'Probe rejections are NOT blacklisted or persisted; runtime self-healing — real gateway failures temporarily skip the level (session-only, resets on restart). Working levels are written to capability declarations (hand-written declarations get new levels appended).',
      },
    }
    function makeT(locale) {
      const dict = (locale === 'en' ? LANG.en : LANG.zh)
      return (key, ...args) => {
        const v = dict[key] !== undefined ? dict[key] : LANG.zh[key]
        return typeof v === 'function' ? v(...args) : v
      }
    }

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' }
    const labelStyle = { minWidth: '150px', fontSize: '13px' }
    const statusStyle = { fontSize: '12px', opacity: 0.8, marginTop: '8px' }
    const hintStyle = { fontSize: '12px', opacity: 0.65, marginTop: '12px', lineHeight: 1.6 }
    const sectionTitle = { fontSize: '14px', fontWeight: 600, margin: '20px 0 6px' }
    const tableStyle = { borderCollapse: 'collapse', width: '100%', fontSize: '12px' }
    const cellStyle = { border: '1px solid rgba(128,128,128,0.35)', padding: '4px 8px', textAlign: 'left' }

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
      const t = props.t || ((k) => LANG.zh[k])
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
            applyNote = '，' + t('probeDone', String(results.length), String(applied.writes ?? (applied.error ? '—' : 0)))
            if (applied.error !== undefined) {
              applyNote += '（' + applied.error + '）'
              setProbeSummaryOk(false)
            }
          } catch (error) {
            applyNote = '，' + t('probeApplyFail')
            setProbeSummaryOk(false)
          }
          setProbeSummary(applyNote)
          setProbeProgress('')
          setProbing(false)
        })()
      }

      const probeLevelLabel = (l) => (LEVEL_LABELS[l] || l)

      const exportCsv = () => {
        const rows = [['模型', '调用', '等级分布', '思考tokens', '思考字符', '输出tokens', '平均耗时ms', '错误率%']]
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
        return el('div', { style: hintStyle }, '统计端点不可用（宿主未挂载 webServer 或插件未运行）。')
      }
      if (stats === null) {
        return el('div', { style: hintStyle }, '统计加载中…')
      }

      const modelRows = Object.entries(stats.models ?? {}).sort((a, b) => b[1].calls - a[1].calls)
      const blackEntries = Object.entries(stats.blacklist ?? {})
      const avgDuration = (agg) => (agg.calls > 0 && typeof agg.durationMs === 'number' ? Math.round(agg.durationMs / agg.calls) + 'ms' : '—')
      return el('div', null,
        el('div', { style: statusStyle },
          '自 ' + fmtTime(stats.since) + ' 共 ' + (stats.totalCalls ?? 0) + ' 次调用（每 2s 刷新）'),
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, t('probeLabel')),
          el('button', {
            type: 'button',
            disabled: probing || probeTargets.length === 0,
            onClick: probeAll,
            style: { padding: '4px 10px', fontWeight: 600 },
          }, probing ? t('testing') : t('probeAll')),
          el('button', { type: 'button', onClick: exportCsv, style: { padding: '4px 10px' } }, t('export')),
          el('span', { style: { fontSize: '12px', opacity: 0.65 } }, t('probeFooter', String(probeTargets.length))),
        ),
        probeTargets.length === 0
          ? el('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '6px' } }, t('probeEmpty'))
          : null,
        probeProgress !== '' ? el('div', { style: statusStyle }, probeProgress) : null,
        probeSummary !== '' ? el('div', { style: { ...statusStyle, color: probeSummaryOk ? '#2e7d32' : '#c62828' } }, probeSummary) : null,
        probeResults.length > 0
          ? el('div', null,
              el('div', { style: sectionTitle }, t('probeResultsTitle')),
              el('table', { style: tableStyle },
                el('thead', null, el('tr', null,
                  el('th', { style: cellStyle }, t('probeColModel')),
                  el('th', { style: cellStyle }, t('probeColWorking')),
                  el('th', { style: cellStyle }, t('probeColRejected')),
                  el('th', { style: cellStyle }, t('probeColBlocked')),
                )),
                el('tbody', null, probeResults.map((r, i) => el('tr', { key: i },
                  el('td', { style: cellStyle }, r.key),
                  el('td', { style: cellStyle, color: (r.working ?? []).length > 0 ? '#2e7d32' : undefined },
                    (r.working ?? []).map(probeLevelLabel).join('/') || '—'),
                  el('td', { style: { ...cellStyle, color: (r.rejected ?? []).length > 0 ? '#c62828' : undefined } },
                    (r.rejected ?? []).map(probeLevelLabel).join('/') || '—'),
                  el('td', { style: cellStyle },
                    (r.blocked ?? []).map(probeLevelLabel).join('/') || (r.error !== undefined ? r.error : '—')),
                ))),
              ),
              el('div', { style: hintStyle }, t('probeNote')),
            )
          : null,
        blackEntries.length > 0
          ? el('div', { style: { ...statusStyle, color: '#b26a00' } },
              '⚠ 实测黑名单：' + blackEntries.map(([k, v]) => k + ' 拒绝 ' + v.join('/')).join('；'))
          : null,
        el('table', { style: tableStyle },
          el('thead', null, el('tr', null,
            el('th', { style: cellStyle }, '模型'),
            el('th', { style: cellStyle }, '调用'),
            el('th', { style: cellStyle }, '等级分布'),
            el('th', { style: cellStyle }, '思考'),
            el('th', { style: cellStyle }, '输出'),
            el('th', { style: cellStyle }, '平均耗时'),
            el('th', { style: cellStyle }, '建议'),
          )),
          el('tbody', null, modelRows.map(([key, agg]) => el('tr', { key },
            el('td', { style: cellStyle }, key),
            el('td', { style: cellStyle }, String(agg.calls)),
            el('td', { style: cellStyle }, Object.entries(agg.efforts).map(([k, v]) => k + '×' + v).join('，')),
            el('td', { style: cellStyle }, agg.reasoningTokens > 0 ? String(agg.reasoningTokens) + ' tok' : (agg.reasoningChars > 0 ? '~' + String(agg.reasoningChars) + ' 字' : '—')),
            el('td', { style: cellStyle }, String(agg.outputTokens)),
            el('td', { style: cellStyle }, avgDuration(agg)),
            el('td', { style: cellStyle, color: agg.suggestion ? '#b26a00' : undefined }, agg.suggestion ?? '—'),
          ))),
        ),
        el('div', { style: sectionTitle }, '最近调用'),
        el('table', { style: tableStyle },
          el('thead', null, el('tr', null,
            el('th', { style: cellStyle }, '时间'),
            el('th', { style: cellStyle }, '模型'),
            el('th', { style: cellStyle }, '推理等级'),
            el('th', { style: cellStyle }, '思考'),
            el('th', { style: cellStyle }, '输出'),
            el('th', { style: cellStyle }, '耗时'),
            el('th', { style: cellStyle }, '结果'),
          )),
          el('tbody', null, (stats.recent ?? []).slice(0, 20).map((r, i) => el('tr', { key: i },
            el('td', { style: cellStyle }, fmtTime(r.t)),
            el('td', { style: cellStyle }, r.provider + '/' + r.model),
            el('td', { style: cellStyle }, r.effort === null ? '(默认)' : (LEVEL_LABELS[r.effort] || r.effort)),
            el('td', { style: cellStyle }, r.rt !== null ? String(r.rt) + ' tok' : (r.rc !== null ? '~' + String(r.rc) + ' 字' : '—')),
            el('td', { style: cellStyle }, r.ot === null ? '—' : String(r.ot)),
            el('td', { style: cellStyle }, r.duration === null ? '—' : String(r.duration) + 'ms'),
            el('td', { style: cellStyle }, r.finish ?? '—'),
          ))),
        ),
      )
    }

    // ── 模型级默认编辑器（按各模型实际支持的等级过滤，数据来自 llm.models 实时探测）──
    function ModelDefaults(props) {
      const { api, view, onChange } = props
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
      const selectedEfforts = selected !== undefined && selected.efforts.length > 0 ? selected.efforts : LEVELS
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

      const rows = entries.map(([key, level]) => {
        const info = byKey.get(key)
        const efforts = info !== undefined && info.efforts.length > 0 ? info.efforts : LEVELS
        const supported = efforts.includes(level)
        const options = efforts.map((item) =>
          el('option', { key: item, value: item }, optionLabel(item)))
        if (!supported) {
          // 已配置等级不在该模型支持列表：保留当前值并明示“运行时将跳过”
          options.push(el('option', { key: '__current', value: level }, optionLabel(level) + ' ⚠ 不支持，将跳过'))
        }
        return el('tr', { key },
          el('td', { style: cellStyle },
            key,
            info !== undefined && info.efforts.length > 0
              ? el('span', { style: { opacity: 0.55, marginLeft: '6px' } }, '支持：' + efforts.join('/'))
              : el('span', { style: { opacity: 0.55, marginLeft: '6px' } }, '能力未知')),
          el('td', { style: cellStyle },
            el('select', {
              value: level,
              onChange: (event) => setLevel(key, event.target.value),
              style: { padding: '2px 6px', ...(!supported ? { color: '#b26a00' } : {}) },
            }, options)),
          el('td', { style: { ...cellStyle, whiteSpace: 'nowrap' } },
            el('button', {
              type: 'button',
              onClick: () => removeEntry(key),
              style: { padding: '2px 10px', color: '#c62828' },
            }, '删除')),
        )
      })

      return el('div', null,
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, '添加模型默认'),
          el('select', {
            value: custom,
            onChange: (event) => setCustom(event.target.value),
            style: { padding: '4px 8px', maxWidth: '340px' },
          },
            el('option', { value: '' }, models === null ? '加载模型列表（探测能力）…' : '选择 provider/model'),
            modelGroups.map((m) => el('optgroup', { key: 'g_' + m.provider, label: m.provider },
              m.models.map((mm) => el('option', { key: mm.key, value: mm.key },
                mm.label.replace(m.provider + ' / ', '') + (mm.efforts.length > 0 ? '' : '（无推理等级）')))))),
          el('button', { type: 'button', disabled: custom === '', onClick: addEntry, style: { padding: '4px 10px' } }, '添加'),
          selected !== undefined && selected.efforts.length > 0
            ? el('span', { style: { fontSize: '12px', opacity: 0.65 } }, '该模型支持：' + selected.efforts.join('/') + ' → 默认填入最高档「' + (LEVEL_LABELS[highest(selected.efforts)] || highest(selected.efforts)) + '」')
            : null,
        ),
        entries.length === 0
          ? el('div', { style: hintStyle }, '未配置模型级默认；所有未显式选择等级的调用使用全局默认。')
          : el('table', { style: tableStyle },
              el('thead', null, el('tr', null,
                el('th', { style: cellStyle }, '模型（实测支持等级）'),
                el('th', { style: cellStyle }, '默认等级'),
                el('th', { style: cellStyle }, '操作'),
              )),
              el('tbody', null, rows),
            ),
        el('div', { style: hintStyle },
          '每个模型可选等级来自宿主实时解析的模型能力（pi-ai 目录 + 本插件声明），不同模型不同：只会出现实测支持的档位；',
          '优先级：会话/模型选择器显式选择 > 模型级默认 > 全局默认。标注 ⚠ 的配置在运行时会被自动跳过（保持全局默认）。'),
      )
    }

    // ── purpose 级默认（compaction / session-title 独立等级）──────────────
    function PurposeDefaults(props) {
      const { view, onChange } = props
      const purposes = (view.value && view.value.purposes) || {}
      const setPurpose = (key, level) => {
        const next = { ...purposes }
        if (level === 'follow') delete next[key]
        else next[key] = level
        onChange({ purposes: next })
      }
      const row = (key, label) => {
        const current = purposes[key]
        return el('div', { style: rowStyle, key },
          el('span', { style: labelStyle }, label),
          el('select', {
            value: current !== undefined ? current : 'follow',
            onChange: (event) => setPurpose(key, event.target.value),
            style: { padding: '4px 8px' },
          }, ['follow', ...LEVELS].map((item) =>
            el('option', { key: item, value: item }, item === 'follow' ? LEVEL_LABELS.follow : LEVEL_LABELS[item]))),
          current !== undefined
            ? el('span', { style: { fontSize: '12px', opacity: 0.65 } }, '辅助调用（' + label + '）用此等级')
            : null,
        )
      }
      return el('div', null,
        row('compaction', '压缩 compaction'),
        row('session-title', '标题 session-title'),
        el('div', { style: hintStyle }, '辅助模型调用（会话压缩、标题生成）可独立设置等级，如用 off 省 token。'),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function ReasoningPage(props) {
      const api = props.api
      const t = props.t || ((k) => LANG.zh[k])
      const [view, setView] = useState(null) // llm-reasoning namespace view
      const [summary, setSummary] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')

      const refresh = () => {
        api.settings.describe({}).then((response) => {
          if (!response.result.ok) {
            setNotice('读取失败：' + (response.result.error && response.result.error.message ? response.result.error.message : '未知错误'))
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
        }).catch(() => setNotice('读取状态失败'))
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
            setNotice('保存失败：' + (response.result.error && response.result.error.message ? response.result.error.message : '未知错误'))
          } else {
            refresh()
            setNotice('已保存，立即对后续请求生效')
          }
        }).catch(() => setNotice('保存失败')).then(() => setBusy(false))
      }

      if (view === null) {
        return el('div', { style: { padding: '16px', fontSize: '13px', opacity: 0.7 } }, '加载中…')
      }

      const value = view.value || {}
      const enabled = value.enabled !== false
      const level = LEVELS.includes(value.level) ? value.level : 'high'
      const deepseekText = summary === null || summary.deepseek === null
        ? '未设置（保持原状）'
        : ('设置为 ' + (LEVEL_LABELS[summary.deepseek] || summary.deepseek))

      return el('div', { style: { padding: '16px' } },
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, '启用统一默认推理等级'),
          el('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: busy,
            onChange: (event) => change({ enabled: event.target.checked }),
          }),
        ),
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, '默认推理等级（全局）'),
          el('select', {
            value: level,
            disabled: busy || !enabled,
            onChange: (event) => change({ level: event.target.value }),
            style: { padding: '4px 8px' },
          }, LEVELS.map((item) => el('option', { key: item, value: item }, LEVEL_LABELS[item]))),
        ),
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, '同步默认 agent 模型等级'),
          el('input', {
            type: 'checkbox',
            checked: value.syncDefaultAgent === true,
            disabled: busy || !enabled,
            onChange: (event) => change({ syncDefaultAgent: event.target.checked }),
          }),
        ),
        el('div', { style: statusStyle },
          summary === null
            ? '统计中…'
            : '已应用：' + summary.routes + ' 个路由 / ' + summary.models + ' 个模型 · DeepSeek 官方：' + deepseekText,
        ),
        notice !== '' ? el('div', { style: { ...statusStyle, color: '#2e7d32' } }, notice) : null,
        el('div', { style: sectionTitle }, t('modelDefaults')),
        el(ModelDefaults, { api, view, onChange: change }),
        el('div', { style: sectionTitle }, t('purposeLevels')),
        el(PurposeDefaults, { view, onChange: change }),
        el('div', { style: sectionTitle }, t('stats')),
        el(StatsPanel, { api, t }),
        el('div', { style: hintStyle },
          '说明：全局默认动态生效——修改后下一次模型请求即采用新等级。手写声明的模型自动补齐「推理等级」能力（含最大 Max）；',
          '每条路由只有在全部模型都支持该等级时才写入默认值。统计中的“推理等级”是该次请求实际携带的等级（会话显式选择或默认物化后的最终值）。',
        ),
      )
    }

    const inject = ['slots', 'connection', 'locale']

    function apply(ctx) {
      const connection = ctx.get('connection')
      if (!connection) return
      const api = connection.api
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
        (props) => el(ReasoningPage, { api, t }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
