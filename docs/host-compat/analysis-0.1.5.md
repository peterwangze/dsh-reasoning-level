# DSH 0.1.5-rc 兼容性实证分析报告

> Task: MAINT-029 | 项目: dsh-reasoning-level v0.7.5 | 核对日期: 2026-09-14（Coordinator 逐项核对）
>
> 本报告所有结论均来自 2026-09-14 的逐项实证核对（静态面），证据位置行号照抄核对记录，未含任何未验证断言。运行时行为以 `node --test` 全量 + `node scripts/client-smoke.mjs` 门禁代跑为准（见文末门禁记录）。

## 1. 环境事实

| 项 | 事实 |
|---|---|
| npm dist-tags `latest` | dist-tags 按包独立（查询时刻 2026-09-14）：`@deepseek-ai/dsh` 元包 latest=0.1.5-rc.1（发布 2026-09-10 03:00:05Z）；`@deepseek-ai/dsh-settings` 等工作区包 latest=0.0.1-rc.1 |
| npm dist-tags `next` | `@deepseek-ai/dsh` 元包 next=0.1.5-rc.2（发布 2026-09-10 14:43:58Z） |
| 现网宿主树 | `C:/Users/peter/.dsh/profiles/node_modules/@deepseek-ai/*` 工作区包 = 0.1.5-rc.2 |
| 本仓库 devDeps 基线 | 0.1.2-rc.1 |
| 核对方式 | v0.7.5 插件全部宿主触点 × 0.1.5-rc.2 宿主树静态逐项比对（0.1.2-rc.1 作差异基线） |
| 门禁基线 | `node --test` 71/71 pass（含 settings-namespace-compat / host-face-contract / client-host-face-compat 判别组）；`node scripts/client-smoke.mjs` 5 组件 OK（exit 0） |

## 2. 触点核对矩阵（10 项全兼容静态面）

| # | 触点 | 宿主包 | 两版对比结论 | 证据位置 |
|---|------|--------|--------------|----------|
| 1 | dsh-settings 导出面 | @deepseek-ai/dsh-settings | 两版一致：`{SettingsConflictError, SettingsProvider, default, redactSecrets}`（两版 keys 完全一致均另含 `__esModule`——interop 元数据非 API） | dsh-settings 包导出面（0.1.2-rc.1 ↔ 0.1.5-rc.2） |
| 2 | `parseSettingsNamespace` 函数体 | @deepseek-ai/dsh-settings | 0.1.2-rc.1 ↔ 0.1.5-rc.2 逐字节一致（MAINT-021 本地回退校验器仍逐字有效） | dsh-settings `parseSettingsNamespace` 函数体 |
| 3 | 4 事件名存续 | dsh-settings / dsh-agent-loop / dsh-llm | `settings/updated`、`agent/request`、`agent/request-error`、`llm/stream` 全部存续 | `settings/updated`（dsh-settings/lib/index.js L566）、`agent/request`（dsh-agent-loop/lib/index.js L1143）、`agent/request-error`（L1088）、`llm/stream`（dsh-llm/lib/index.js L2307） |
| 4 | `webServer.register({kind:'exact',path,handler})` | @deepseek-ai/dsh-host-webserver | 存续 | dsh-host-webserver/lib/index.js L176-178 |
| 5 | settings RPC 方法集 + modelCatalog | @deepseek-ai/dsh-api-remotes | settings RPC 7 方法集两版一致（describe/update/mutate/replace/openSettingsDocument/openAgentPresetDirectory/canOpenAgentPresetDirectory）；`session.modelCatalog` 存续 | dsh-api-remotes/lib/client.js L5038-5221 / L8164+L8625 |
| 6 | `resolveCallWithInfo` effort 校验结构 | @deepseek-ai/dsh-llm | 未变 | 0.1.5 L2111-2127；0.1.2 L1561-1577 |
| 7 | `agent/request` payload `reasoningEffort` | @deepseek-ai/dsh-agent-loop | 字段 + schema 存续（`reasoningEffort: z.string().min(1)`） | dsh-agent-loop L1136-1140 / L1497 |
| 8 | cordis / schemastery 传递依赖 | @deepseek-ai/cordis、@deepseek-ai/schemastery | cordis 4.0.1 ↔ 4.0.2 lib/index.js SHA256 一致（1729CDBF8EE40B17…）；schemastery 3.18.1 ↔ 3.18.2 lib/index.mjs、lib/index.cjs SHA256 一致 | 包文件 SHA256 比对 |
| 9 | 服务面 API | dsh-settings / dsh-llm | `settings.register(ns, schema)`、`settings.get(ns)`、`llm.resolveModelInfo(provider, model, signal)`、`llm.stream(options)` 全部存续 | dsh-settings L281/L388、dsh-llm L2043、L2303 |
| 10 | `dsh.client.inject` 声明 | 宿主 client 注入面 | **唯一缺陷**——详见 §3 | package.json L23（清理前） |

## 3. 缺陷：`dsh.client.inject` 中的 `@deepseek-ai/dsh-client-runtime` 死声明

**现象**：v0.7.5 `package.json` 的 `dsh.client.inject` 数组含 4 项，其中 `"@deepseek-ai/dsh-client-runtime"` 为死声明。

**实证依据**（全部为 2026-09-14 核对所得）：

1. **0.1.5 宿主树不存在该包**：对现网宿主树实测 `Test-Path` 返回 False，且全树 grep 零引用。
2. **原生 client 插件均不声明**：宿主树 47 个 `dsh-client*` 包的 package.json 实测全部不含该 inject 项。
3. **native 参照**（dsh-client-ui-settings-models@0.1.5-rc.2 package.json）：inject = `["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-remotes"]`。
4. **静默跳过而非报错**：宿主 client-modules `arriveGraphRow`（dsh-client-modules/lib/client.js L265-268）对 graphRows 中不存在的 inject 名静默跳过——故该死声明不产生运行时故障，属无效冗余配置。
5. **历史考古**：自首 commit 49f6582 即存在（`git log --oneline -S 'dsh-client-runtime' -- package.json` 实证仅首 commit 引入，此后无变更）。

**清理**（MAINT-029）：从 `dsh.client.inject` 移除 `"@deepseek-ai/dsh-client-runtime"`，保留三项 `["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-remotes"]`，与 native 参照一致。测试面核对结论：全仓（test/、README.md、VERIFICATION.md）无任何对该 inject 项的引用或断言，`dsh-client-runtime` 仅出现在 package.json 此一处——清理无连带修改面。

## 4. 结论

1. **静态面全兼容**：v0.7.5 全部宿主触点（§2 的 1-9 项）在 0.1.5-rc.2 宿主树上逐一存续且两版结构一致，传递依赖（cordis/schemastery）字节级一致——**v0.7.5 对 0.1.5-rc.2 静态面可安全重装**。
2. **唯一缺陷已清理**：`dsh.client.inject` 死声明项移除后与宿主原生 client 插件声明面完全对齐（§3）。
3. **后续演进指向**：宿主面向 0.1.5-rc 演进的相关适配（FEAT-001/002）另行立项跟进，不在本报告范围内展开。
