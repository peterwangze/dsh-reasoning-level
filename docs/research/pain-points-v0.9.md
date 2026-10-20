# 用户痛点调研 — 思考等级配置（v0.9.0 依据）

> 任务：FEAT-003；决策：DEC-020；方法：**证据分级**——A 级=本机活体/代码/配置实测，B 级=外部一手文档与官方仓库，C 级=推断（明确标注"待验证"，不得作为设计唯一依据）
> 调研日期：2026-10-20

## 0. 一句话结论

这个插件已经解决了「**配不了**」，但用户真实的使用形态是「**全开 max、看不见代价、探测失败看不懂**」。真正缺的不是功能，是**决策支持**与**可解释性**。

## 1. A 级证据：本机活体使用事实

来源：`GET http://127.0.0.1:3080/reasoning-level-stats`（真实运行实例，`totalCalls=81926`，`contractHealth.ok=true`）+ `C:\Users\peter\.dsh\profiles\web\cordis.patch.yml`（真实配置面）。

### 1.1 等级选择事实上没有发生

| 模型 | 调用数 | 等级分布 |
| --- | --- | --- |
| `zai-coding-cn/glm-5.3` | 20,148 | `max` 20,084 / `(默认)` 63 / `high` 5 / `off` 1 |
| `deepseek-official/deepseek-flash` | 18,777 | `max` 18,736 / `(默认)` 40 / `off` 1 |
| `zai-coding-cn/glm-5.3-flash` | 10,836 | `max` 10,832 / `(默认)` 4 |
| `command-code/deepseek/deepseek-v4.1-flash` | 7,285 | `max` 7,275 / `(默认)` 10 |
| `glm-local/glm-5.3` | 6,776 | `max` 6,750 / `(默认)` 21 / `high` 5 |
| `command-code/z-ai/glm-5.3-flash` | 2,966 | `max` 2,966 |

**事实**：30 个模型里，`minimal` / `medium` / `xhigh` 三档**从未出现过一次**。7 档词表实际只会用到 `off/low/high/max` 四档。

**含义**：用户不是在「按任务挑档位」，而是在「全开最大，然后忘掉这件事」。这直接说明——
- 「7 档下拉」不是自由度，而是认知负担；
- 用户没有成本/延迟的对照信息，因此无法产生「该降档」的动机；
- 插件宣称的核心价值（统一配置 + 按需分级）在真实使用中只兑现了一半。

### 1.2 思考量对用户不可见

| 事实 | 数据 |
| --- | --- |
| 回报 `reasoningTokens` 的模型 | 仅 `deepseek-official/*` 3 个（9,263,006 + 1,181,494 + 254,069 tok） |
| 不回报的模型 | 其余 27 个全部 `reasoningTokens=0`，`reasoningChars=0` |
| 覆盖厂商 | zai / command-code / craze-code / cucloud / glm-local / opencode-go 全部为 0 |

**含义**：设置页「思考」列对这些模型恒为 `—`。用户看到一排横线，合理推断是「这个模型不思考」——但真实情况是**网关不回报该字段**，模型很可能在思考。这是**误导性空白**，不是信息缺失。

### 1.3 探测失败是黑盒

`lastProbe.models`（最近一次全量探测）：

| 模型 | working | rejected | blocked | persisted |
| --- | --- | --- | --- | --- |
| `openai-codex/gpt-5.6-sol` | — | — | **全部 7 档** | `skipped:no-working` |
| `openai-codex/gpt-6-astra` | — | — | **全部 7 档** | `skipped:no-working` |
| `openai-codex/gpt-5.6-luna` | — | — | **全部 7 档** | `skipped:no-working` |
| `openai-codex/gpt-5.6-terra` | — | — | **全部 7 档** | `skipped:no-working` |
| `deepseek-official/deepseek-flash` | off/low/high/max | minimal/medium/xhigh | — | `skipped:not-in-pi-ai-config` |
| `deepseek-account/*` | 同上 | 同上 | — | `skipped:not-in-pi-ai-config` |
| `command-code/*` ×4 | off/low/medium/high/xhigh/max | — | `minimal` | written / converged |
| `craze-code/gpt-6.1-sol` | medium/high/xhigh/max | — | off/minimal/low | written |

**三个可核实的问题**：

1. **`blocked` 无原因**。`/probe` 的响应里**已经有** `levels[level] = { ok, kind, code, message, durationMs }`（`lib/index.js:1228-1242`），但客户端只读 `working/rejected/blocked` 三个数组（`lib/client.js:625-627`），错误码与错误文本**被直接丢弃**。页面上因此只剩「无可用等级」。
2. **`not-in-pi-ai-config` 是误报式文案**。`deepseek-official/*` 与 `deepseek-account/*` 由宿主 `llm-deepseek` 适配器管理，本来就不在 `llm-pi-ai` 的 `providers` 里——它们的等级由 `llm-deepseek.reasoningEffort` 控制（配置里确实是 `max`）。所以这不是「写入失败」，而是「走了另一条本该走的通道」。页面却说「不在 llm-pi-ai 配置——仅展示，未写入」，读起来像错误。
3. **`openai-codex/*` 全 blocked 的可疑成因（C 级，待验证）**：该 provider 在 `llm-pi-ai` 里声明 `apiKeyEnv: DSH_ROUTER_OPENAI_CODEX`，而 `dsh-agent-router` 同时配置了 `oauthAccounts.chatgpt`（`preset: chatgpt-codex`、`protocol: codex-responses`）——说明这条链路实际由 router 注入凭据。插件探测走 `llm.stream` 的直连适配器路径，若该环境变量在宿主进程内不可见，7 档必然全失败。**待验证方式**：读取 `/probe` 响应的 `levels.*.code`（UI 当前丢弃了它）。**不做未经验证的结论**，但无论成因是什么，「把 code/message 显示出来」都是必须的。

### 1.4 结构性错配：7 档词表 × 实际支持面

| provider / 模型 | 实测可用档 |
| --- | --- |
| deepseek-official / deepseek-account（DeepSeek 系） | `off` `low` `high` `max`（**拒绝** minimal/medium/xhigh） |
| zai-coding-cn / cucloud | 全部 7 档 |
| command-code | 6 档（**blocked** `minimal`） |
| craze-code / gpt-6.1-sol | 4 档（`medium` 起步） |

**含义**：对 DeepSeek 系每次探测要打 3 个注定失败的档位；对 craze-code 要打 3 个。用户看到一堆红叉，不知道自己「配置错了」还是「模型就这样」。

### 1.5 配置面事实（`cordis.patch.yml`）

- `llm-reasoning.level = max`、`syncDefaultAgent = true`、`applied.deepseek.level = max`；
- `llm-pi-ai.providers.*.reasoning = max`（7 条路由全部 max）；
- `probeEfforts` 里已有 9 个模型的固化声明；
- 用户手工维护了 7 个 provider、30+ 模型的 `reasoningEfforts`（多数由插件收敛写入）。

**含义**：用户是这个插件的重度使用者（不是尝鲜者）。对重度用户来说，页面的价值密度比"能不能点"更重要。

## 2. A 级证据：代码面 UX 缺陷

| # | 缺陷 | 位置 | 用户后果 |
| --- | --- | --- | --- |
| D1 | 等级选择是裸 `<select>`，7 个中文短词无含义/无场景/无代价 | `lib/client.js:970-976`、`:840-845` | 不知道 `high` 与 `max` 差别，只能全选最大 |
| D2 | 首屏没有「我现在到底在用什么」的摘要，只有一行拼接长句 `已应用：a=高；b=高 / 2 个模型 · DeepSeek 官方：设置为 最大` | `:986-990`、`:126` | 需要逐段读才能拼出结论 |
| D3 | 添加模型要走 `<select>` 全量下拉（按 provider 分组 optgroup），30+ 模型 | `:794-808` | 找一个模型要翻很久；无法按名字搜索 |
| D4 | 能力信息只在「已配置行」内显示，未配置模型的支持面完全不可见 | `:770-778` | 无法预判「把全局设成 x 会波及谁」 |
| D5 | 探测 `blocked` 只显示档位 chips，`levels[].code/message` 被丢弃 | `:625-627` | 「全 blocked」无法定位原因 |
| D6 | `persisted` 文案把「官方适配器管理」说成「不在配置——仅展示未写入」 | `:628`、`:190` | 以为探测失败/配置错了 |
| D7 | 思考量列在网关不回报时显示 `—`，无任何解释 | `:658`、`:683` | 误判「该模型不思考」 |
| D8 | 表格 hover 用 React state 模拟（每行一个 `useState` + 两个 handler） | `:342-352` | 大表（100 行）产生 200 个状态节点；无 `:focus-visible` |
| D9 | 全部样式内联，无法表达 hover/focus/media query/transition | 全文 | 窄屏塌陷；键盘用户无焦点提示；无过渡动效 |
| D10 | `LEVEL_LABELS` 仅中文，en 语境等级名仍显示中文 | `:31` | 英文界面中英混排（UX-002 遗留） |
| D11 | 统计面板无暂停、无筛选、无排序；2s 轮询无条件刷新 | `:401-410` | 想仔细看某一行时表格一直在动 |
| D12 | 改设置无撤销，失败仅一行红字 | `:910-928` | 误操作只能手动改回，且不知改前是什么值 |
| D13 | 探测进度只有一行文本 `探测中 3/17：...`，无进度条/无数目 | `:75` | 长时间探测时不知道还要多久 |
| D14 | 支持矩阵缺失：用户无法一眼看出 30 个模型的能力分布 | 无此功能 | 这是「7 档 vs 实际 4 档」困惑的根因 |

## 3. 痛点归纳（现象 → 需求 → 机会）

| 痛点 | 现象（证据） | 未满足需求 | v0.9.0 承载 |
| --- | --- | --- | --- |
| **P1 选不出** | 从未使用 minimal/medium/xhigh；max 占 99%+ | 需要「每档意味着什么、适合什么任务」的即时解释 | UX-003 分段控件 + `LEVEL_HINTS` |
| **P2 看不见代价** | 无任何按等级的成本/耗时对照 | 需要「同一模型 max vs high 差多少」的实测对照 | FEAT-005 per-level 聚合 + 等级对比视图 |
| **P3 不知波及谁** | 全局档位变化的影响面不可见 | 需要「这一档有多少模型支持、多少会跳过」的预览 | FEAT-004 影响预览 |
| **P4 找不到模型** | 30+ 模型的 optgroup 长下拉 | 需要可搜索的模型选择 | FEAT-004 搜索 |
| **P5 看不懂失败** | 4 个模型 7 档全 blocked 无原因 | 需要错误归因（鉴权/下线/限流/超时） | FEAT-004 归因分诊 + 服务端 `blockedReasons` |
| **P6 误读「未写入」** | `not-in-pi-ai-config` 被当成失败 | 需要区分「走官方适配器」与「真的没写进去」 | FEAT-004 文案与语义重写 |
| **P7 误读「没思考」** | 27/30 模型思考量显示 `—` | 需要明确「网关不回报」这个事实本身 | UX-003 思考量 Tile + FEAT-004 说明 |
| **P8 无法回退** | 改错只能手动改回 | 需要一次撤销 | FEAT-004 undo toast |
| **P9 观感粗糙** | 无焦点态、无过渡、窄屏塌陷、长句状态行 | 需要「像宿主原生设置页」的视觉与信息层级 | UX-003 全量 |

## 4. 外部生态证据

> **取证限制（如实声明）**：本会话 `web_fetch` 被环境阻断（目标域名解析到非公网 IP，全部请求报 `hostname resolves to a non-public IP address`），因此下列证据只能取到**搜索结果摘要级**（B− 级：标题 + 摘要片段，无法逐篇核对全文）。凡未读到正文的判断一律标注「摘要级」。

### 4.1 等级命名在生态里没有统一标准（→ 支持"词表归一"而非"增加档位"）

- **`xhigh` / `max` 需要额外扩展 schema 才能被接受**：OmniRoute 的 PR 标题即「fix: add xhigh+max to effortLevel schema」，说明主流实现默认只认 4 档时，`xhigh`/`max` 属于"外挂档位"。来源：[OmniRoute PR #2666](https://github.com/diegosouzapw/OmniRoute/pull/2666)（摘要级）
- **存在专门的"归一化"层**：terva provider 的 `NormalizeReasoning` 负责把用户可见思考等级规范化到 provider 能接受的值。来源：[terva provider 文档](https://pkg.go.dev/terva.sh/terva/packages/provider@v0.131.5)（摘要级）
- 与本地证据 §1.4 一致：同一条请求在不同 provider 上有效档位集合完全不同（DeepSeek 系 4 档 / zai 7 档 / craze-code 4 档）。

**设计含义**：用户面对的不是"档位太少"，而是"档位含义与可用性不一致"。增加档位只会放大不一致 → v0.9.0 选择「把 7 档的含义讲清楚 + 把每个模型的支持面画出来」。

### 4.2 "配置了但没生效"是这个领域的通用顽疾（→ 支持"可解释性优先"）

- **effort 被中转层静默改写**：NousResearch hermes-agent 的 issue 标题即为「reasoning effort "max" is silently rewritten to "xhigh" on custom OpenAI-compatible relays (api_mode: codex_responses)」。来源：[hermes-agent #114249](https://github.com/NousResearch/hermes-agent/issues/114249)（摘要级）
- **命令行参数被静默忽略**：agent-intern 的 issue 指出「`--model/--effort` being silently ignored in headless `-p`」。来源：[agent-intern on PyPI](https://pypi.org/project/agent-intern/0.28.1/)（摘要级）
- **`off` 并不真的关掉思考**：hermes-agent issue #118871「a bare reasoning effort "none" still bills thinking on profile wires … silently ignored (DeepSeek / Kimi)」。来源：[hermes-agent #118871](https://github.com/NousResearch/hermes-agent/issues/118871)（摘要级）
- **同一类插件已把"provider 拒绝就回退"做成显式特性**：onyx 的 PR 标题「feat(llm): per-session reasoning effort control and provider-rejection fallback」。来源：[onyx PR #13378](https://www.cubic.dev/pr/onyx-dot-app/onyx/pull/13378)（摘要级）

**设计含义**：这些证据与本地 P5/P6 痛点同源——**用户无法区分「我设了没用」和「设了但被下游改掉」**。本插件的相对优势是它就在 host 侧、能看到 wire 上的真实 effort；v0.9.0 应把这项能力用在「显示实测结局与原因」上，而不是再增加配置项。

### 4.3 官方实现的档位事实（用于校准，摘要级）

- Codex CLI 使用 `model_reasoning_effort`（`minimal/low/medium/high` 语族）。来源：[Codex CLI 配置参考](https://mintlify.wiki/openai/codex/configuration/reference)（摘要级；注意该域名在本机不可达，仅摘要）
- Claude Code 通过环境变量族（如 `MAX_THINKING_TOKENS`）控制思考预算。来源：[Claude Code 环境变量文档](https://code.claude.com/docs/pt/env-vars#10)（摘要级）
- OpenRouter 在请求侧提供 `reasoning` / `reasoning.effort` 语义与「reasoning tokens」可观测量。来源：[OpenRouter Reasoning Tokens 文档](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#1)（摘要级）

> **未验证项（明确标注，不作为设计依据）**：各 provider 对 `xhigh` 的具体 wire 映射、以及"网关是否普遍不回报 `reasoningTokens`"的行业比例——前者需要逐家文档核对，后者需要更大样本。本地证据（27/30 模型不回报）只代表**本机环境**。

### 4.4 外部证据对本轮范围的影响

1. **不引入新档位、不改词表**（生态已在为档位不一致付出成本，我们不该增加不一致面）。
2. **强化"显示真实结局"**（配置不生效是领域通病，可见性是最便宜的解法）。
3. **`off` 语义要更诚实**：外部证据表明 `off` 未必真的关闭思考——本插件的 `off` 在 zai/deepseek thinking 格式下显式发 `disabled`（README 已记载），但 UI 里只说"关闭"，需要补一句"部分网关仍可能计费思考"。

## 5. 设计含义（可执行结论）

1. **不要增加档位数量**——真实使用只覆盖 4 档，增加只会加重负担；要把「已有 7 档的含义」讲清楚。
2. **把"代价"做成第一类信息**，而不是藏在表格里：没有代价对照，用户就不会产生降档动机。
3. **错误必须可归因**：数据已经存在于响应里（`levels[].code`），只是没显示——这是纯 UI 亏损，修复成本极低、感知收益极高。
4. **"未写入"要区分三种语义**：①真失败；②走官方适配器（本该如此）；③不在配置里（需要用户先去模型配置添加）。
5. **重度用户优先**：页面要在滚动前就回答「我在用什么 / 影响谁 / 值不值」。

## 6. 证据清单

| 证据 | 方式 | 可复现命令/位置 |
| --- | --- | --- |
| 调用分布与等级分布 | 活体 HTTP | `curl http://127.0.0.1:3080/reasoning-level-stats` → `models[*].efforts` |
| 探测结局 | 活体 HTTP | 同上 → `lastProbe.models` |
| 思考量覆盖 | 活体 HTTP | 同上 → `models[*].reasoningTokens` |
| 配置面 | 文件读取 | `C:\Users\peter\.dsh\profiles\web\cordis.patch.yml` |
| 探测错误码在生产响应中 | 代码 | `lib/index.js:1228-1242`（返回）↔ `lib/client.js:625-627`（丢弃） |
| UI 缺陷 D1-D14 | 代码 | 见 §2 行号 |
