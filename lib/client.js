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
    function StatsPanel(props) {
      const api = props.api
      const [stats, setStats] = useState(null)
      const [failed, setFailed] = useState(false)
      const [testTarget, setTestTarget] = useState('')
      const [testLevel, setTestLevel] = useState('')
      const [testResult, setTestResult] = useState('')
      const [testing, setTesting] = useState(false)
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

      const runTest = () => {
        if (testTarget === '' || testLevel === '') return
        setTesting(true)
        setTestResult('')
        const [provider, model] = testTarget.split('/')
        fetch('/reasoning-level-stats/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, model, level: testLevel }),
        })
          .then((r) => r.json())
          .then((r) => {
            setTestResult(r.ok
              ? '✓ ' + testTarget + ' · ' + (LEVEL_LABELS[testLevel] || testLevel) + ' 可用（' + (r.durationMs ?? '?') + 'ms）'
              : '✗ ' + testTarget + ' · ' + (LEVEL_LABELS[testLevel] || testLevel) + ' 不可用' + (r.error ? '：' + r.error : '') + (r.blacklisted ? '（已入黑名单）' : ''))
          })
          .catch(() => setTestResult('测试请求失败'))
          .then(() => setTesting(false))
      }

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
      const modelKeys = Object.keys(stats.models ?? {})
      return el('div', null,
        el('div', { style: statusStyle },
          '自 ' + fmtTime(stats.since) + ' 共 ' + (stats.totalCalls ?? 0) + ' 次调用（每 2s 刷新）'),
        el('div', { style: rowStyle },
          el('span', { style: labelStyle }, '实测等级'),
          el('select', {
            value: testTarget,
            onChange: (event) => setTestTarget(event.target.value),
            style: { padding: '4px 8px', maxWidth: '260px' },
          },
            el('option', { value: '' }, '选择模型'),
            modelKeys.map((k) => el('option', { key: k, value: k }, k))),
          el('select', {
            value: testLevel,
            onChange: (event) => setTestLevel(event.target.value),
            style: { padding: '4px 8px' },
          },
            el('option', { value: '' }, '等级'),
            LEVELS.map((l) => el('option', { key: l, value: l }, LEVEL_LABELS[l]))),
          el('button', { type: 'button', disabled: testing || testTarget === '' || testLevel === '', onClick: runTest, style: { padding: '4px 10px' } },
            testing ? '测试中…' : '测试'),
          el('button', { type: 'button', onClick: exportCsv, style: { padding: '4px 10px' } }, '导出 CSV'),
        ),
        testResult !== '' ? el('div', { style: { ...statusStyle, color: testResult.startsWith('✓') ? '#2e7d32' : '#c62828' } }, testResult) : null,
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
        el('div', { style: sectionTitle }, '模型级默认'),
        el(ModelDefaults, { api, view, onChange: change }),
        el('div', { style: sectionTitle }, '辅助调用等级'),
        el(PurposeDefaults, { view, onChange: change }),
        el('div', { style: sectionTitle }, '实时调用统计'),
        el(StatsPanel, { api }),
        el('div', { style: hintStyle },
          '说明：全局默认动态生效——修改后下一次模型请求即采用新等级。手写声明的模型自动补齐「推理等级」能力（含最大 Max）；',
          '每条路由只有在全部模型都支持该等级时才写入默认值。统计中的“推理等级”是该次请求实际携带的等级（会话显式选择或默认物化后的最终值）。',
        ),
      )
    }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const connection = ctx.get('connection')
      if (!connection) return
      const api = connection.api
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'reasoning-level', order: 12, label: () => '统一推理等级' },
        (props) => el(ReasoningPage, { api }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
