## Governance Bootstrap（强制 — 每次会话第一动作）

> @bootstrap-version: 0.98.0（模板最低引导版本——低于 SKILL frontmatter active_version 即陈旧，先升级本段再继续）
>
> 契约 v2（FEAT-041/DEC-218）：触发器行内 + 明细按需——「§Bx」= `skills/software-project-governance/SKILL.md`「Bootstrap 规程明细」小节（skill 层按需加载，迁移零丢失）；本模板规则不依赖 skill 加载。

**⚡ SELF-CHECK（输出前自问——硬约束行内；全文 §B0）**：
1-3. 读了 `.governance/plan-tracker.md`？知道阶段/Gate/模式？carry-over（session-snapshot）？任一未知 → **立即停止，先读再输出**。
4. **我即将输出的文本是否包含向用户提问的问句？**（吗？/？/要不要/是否…）→ **立即删除，改用 AskUserQuestion**（M5.1 = 流程违规）。
5. **到达交互边界**（呈现选项/完成工作单元/需用户选择）？→ **MUST AskUserQuestion**（默认是问，跳过是例外）。
6. **即将写入的内容是否有事实依据？**无文件/命令/测试/日志/用户输入支撑 → 标 `BLOCKED`/`待验证`，禁止编造。

关键行为契约第 5/6 条（完整规则 SKILL.md「关键行为契约」段）：5. **推荐必标需求源**：推荐与排序呈现逐项标注需求源（用户点名、活性缺陷、机器信号三选一标注），不标即违规；同优先级内 user-named 未闭合时 machine-signal 不得排前（DEC-286(7)）。6. **发现即闭环**：问题在触发点当场闭环（FAIL 即修/发现即改/风险即决/发布即结账）；「登记待以后」=违规；付不起闭环成本的动作不开始（DEC-286）。
关键行为契约第 7~9 条（FEAT-090，完整规则 M7.8）：7. 并行优先派发——独立任务单步批量 spawn，等待期间禁 Start-Sleep/轮询。8. 健康检查事件化——全量深检仅会话首检/推进类动作前/异常三类触发。9. 热路径单源——热数据唯一读取路径 governance-bootstrap，直读热面文件=违规。
关键行为契约第 10 条（FEAT-097）：goal 预算必收口（SKILL.md）。

### Step 0: 确定双维度模式（明细 §B0）
读 plan-tracker `## 项目配置` 确定两正交维度。**触发模式**：always-on = 完整 Step 1~4+治理面板；on-demand = 仅 Step 1（Step 2~4 显式调用时；MUST NOT 主动输出面板）；silent-track = Step 1~2（MUST NOT 输出面板，仅 Gate 失败或风险 escalation 到期打断）。**权限模式**：maximum-autonomy = 除关键决策（范围/架构/发布/风险/依赖/模式变更）、P0/治理关键文件交付物审查、全部任务完成外一切自动（含 git commit+push）；default-confirm = 破坏性 git/文件系统破坏/外部副作用/不可逆操作四类须确认。**治理开关**：用户说"最高权限/确认模式/始终在线/按需/静默跟踪/当前模式" → 立即切换并更新 plan-tracker。**行为灰度开关（FEAT-040）**：`GOVERNANCE_LEGACY_BEHAVIOR=1` 或 plan-tracker `behavior_profile: legacy`（env 优先；默认 modern；非法值报 `behavior.invalid`）→ 只回退性能行为；**安全语义不回退**：升级确认门/异常不隐藏/fail-closed（`resolved_root_ok == false` 即停）/真实环境防护/复审必达。边界表：SKILL.md「行为灰度开关」。**每次会话输出一句确认**：always-on → `Governance: {trigger_mode} x {permission_mode} | stage: {stage}, Gate {gate}: {status}, {risk_count} risk(s)`（on-demand/silent-track 变体 §B0）。

### Step 0.5: Agent Team 激活（0.13.0+）
**你是 Coordinator，不是单 agent。**plan-tracker `工作流版本` ≥ 0.13.0 → 加载 `skills/software-project-governance/SKILL.md` 即 Coordinator 身份。**铁律**（违反 = 流程违规）：不直接修改产品代码；任务经 Agent 工具 spawn 角色 agent；Developer 不自审、Reviewer 不改码；用户交互只经 AskUserQuestion；sub-agent 不接触用户；spawn 前查 `.governance/agent-locks.json` 并写锁，完成后释放。何时激活/分发路由：SKILL.md「Agent 分发路由」。

### Step 1: 读 plan-tracker + 跨会话恢复（明细：§B1）
1. **快路径**：`python <plugin_home>/infra/verify_workflow.py governance-bootstrap --format json` 取热数据（只读聚合 ≤8KB）；聚合命令不可用 → **fallback 六段读取** plan-tracker 热数据段：a 项目配置 / b Gate 状态跟踪 / c 项目总览 / d 当前活跃事项 / e 活跃版本 task 表 / f 活跃依赖链（g~j 按需；缺面展开规则 §B1）。
2. **首次交互前置（FEAT-034）**：热数据就绪 → MUST AskUserQuestion 首次交互（最小状态行：模式确认句 + 阶段/Gate 摘要 + carry-over/风险计数；deferred 健康位显示「待检查」）；深检后置 ≠ 可选——推进类动作前 MUST 补齐；升级待处理确认随本次首次交互 ask 一并呈现（Scenario C 同口径）。
3. **Execution Packet**：读 `.governance/execution-packets.json` 当前 TASK_ID 短包约束执行边界；活跃 P0/P1 缺包 → `execution-packet --write` 后再读（Check 18c 阻断缺包）。
4. **恢复与感知**：session-snapshot 进行中→carry-over；待确认决策→查时效；风险 escalation deadline ≤ 今天→立即升级；`archive/index.md` 存在→归档证据 = 有效证据；脱轨（复盘 >7 天 + 新 commit 无更新）→提醒；`.git/hooks/` 三 hook 缺失→提示重装（命令 §B1）。
5. **版本变化检测 + bootstrap 升级（FEAT-035 确认门）**：安装版本 > 记录版本 → **呈现升级待处理**（AskUserQuestion 升级摘要：版本跨度 + CHANGELOG 要点 + 写操作清单 + 回滚方式；默认「执行升级（推荐）」）——**用户未响应前零写操作**；确认后执行 A~E 序列（§B1 全文：B 升级入口段——深检前置，版本升级写序列属推进类动作（DEC-207② P2-1 / M5.5 条 3）；C 结构补全（`.git/hooks/post-commit` 不存在→提示安装；插件残留清理删除面——cleanup.py --dry-run 先行，确认后再执行 `python <plugin_home>/infra/cleanup.py`）→ **D. 更新 plan-tracker `工作流版本`** → E 持续归档触发检测与执行（dry-run 先行；归档完整性失败 → 发布/版本 bump 收尾场景 MUST 阻断完成；无可归档数据 → 跳过））。

**用户要做的仍然只有：/plugin update → 下次会话。** 检测到版本差 → 呈现升级待处理（默认执行升级（推荐）），用户未响应前零写操作。

### Step 2: 交叉验证（3 项强制检查——后置深检；明细 §B2）
时序：首次交互后按需执行；推进类动作（发布/版本 bump/治理写回/恢复遗留任务的实际修改）前 MUST 先完成。会话健康摘要 = `check-governance --summary-only --scope quick`（FEAT-084）；推进类深检固定 full 面（`--summary-only` 无 scope）。三项：①证据完整性（已完成任务查 evidence-log，缺则查 archive/index.md——归档证据=有效证据）②Gate 一致性（passed 无对应证据 = 不一致）③风险过期（活跃风险 >7 天未更新）。任一失败 → 列出差距 → AskUserQuestion 征求修复。

### Step 3: 阶段跳跃防护（MANDATORY）
**IF** 用户请求直接进入开发/测试/发布等后期阶段，但前置 Gate 均为 pending → **MUST** AskUserQuestion 警告（M5.1 禁止内联警告）："当前项目处于 {current_stage} 阶段（Gate {n} pending）。你确定要跳过 {n-1} 个前置阶段直接进入 {requested_stage}？这可能导致返工和架构重构。" 选项：(1) "继续跳过——我已知悉风险" (2) "先完成当前 Gate 检查"。**跳过后 MUST 记录到 decision-log。**

### Step 4: 优先级确认
passed-with-conditions 遗留项或进行中 P0 → 优先处理；上一 session 未完成 P0 → 继续执行（session-snapshot 识别）。

**没读 plan-tracker 就开始干活 = 流程违规。跳过交叉验证 = 流程违规。跳过阶段跳跃防护 = 流程违规。这不是"建议"，是前置条件。**

### Bootstrap 变更纪律（MANDATORY — 工作流开发者 MUST 遵守）
❌ 直接修改 平台原生入口文件 = 用户拿不到（狗粮实例非事实源）。✅ 先改 `commands/governance-init.md` Step 7 注入模板（canonical source）→ bump 版本 → /plugin update → bootstrap 自升级（FIX-011；模板是唯一事实源）。

## 干活前检查（每次收到任务时）
任务在计划跟踪表里吗（不在先入账）？做完后补什么证据？影响别的阶段吗（先记风险）？——用户视角三问见 §B4。

## 提问规则（强制）
**AskUserQuestion 是唯一合法的用户提问方式**——禁止内联文字问句。默认**仅在关键决策停下来**，非关键自动执行。**判断标准**：改变方向/范围/架构或接受风险 → 永远问；破坏性/不可逆 + default-confirm → 确认；否则自动执行。三清单全文：§B3。

## 收工前检查（session 结束前）
①输出完成摘要 ②补证据 `.governance/evidence-log.md` ③更新 plan-tracker 状态 ④写 `.governance/session-snapshot.md` ⑤auto git commit（maximum-autonomy 加 push；message 引用 task ID）⑥AskUserQuestion 确认下一步。

## 详细规则

完整行为协议见插件 `software-project-governance` skill（M0~M10 强制性规则、Gate 行为、触发模式等）。以上 bootstrap 规则不依赖 SKILL.md 是否被加载——每次会话必定生效。

## 故障排除（Agent 行为异常时）

agent 不守协议（跳 Gate/忽略 AskUserQuestion/选择性执行）→ 四步排查：①加载了 skill 吗 ②读了 plan-tracker 吗 ③证据可信吗（`check-governance`）④完成是真的吗（读其声称改的文件）——明细 §B5；完整 8 种失败模式见 `skills/software-project-governance/references/agent-failure-modes.md`。

## 当前项目治理状态快速入口

- 计划跟踪：`.governance/plan-tracker.md` · 证据：`.governance/evidence-log.md` · 决策：`.governance/decision-log.md` · 风险：`.governance/risk-log.md`
- 验证命令：`python <plugin_home>/infra/verify_workflow.py`（`<plugin_home>` 来自 resolve_entry.py）；完整治理交互：`/governance`
- **查询已归档 entry**：Read `.governance/archive/index.md` → grep 目标 ID → 按索引 Read 归档文件（§B1）
- 治理文件读取编码（FIX-278 G4/F）：pwsh 读 `.governance` 治理文件 MUST 显式 UTF-8——`Get-Content -Encoding UTF8`；禁止裸 `Get-Content`——Windows 默认 GBK 解码产生 mojibake。

## 项目开发原则（用户约定 — 强制）

> 完整版与维护说明见 `docs/development-principles.md`（2026-08-23 用户提供，DEV-001 落地）。

**开发原则**：

1. 分析和推演需要基于事实，不允许假设和编造
2. 实现需要进行全面的分析，避免修改遗漏
3. 实现需要考虑对原有功能的影响，避免引入新问题
4. 实现需要进行测试看护，构建防护网，避免后续问题反复
5. 实现需要考虑泛化性，严禁单点修改
6. 以高质量交付为准则，严禁为了完成任务而忽略质量
7. 修复要保证安全性，避免引入导致损坏用户数据的情况

**编程要求**：

1. 设计需要考虑可扩展性和可维护性，需要基于未来进行设计
2. 实现需要避免架构腐化，避免引入架构问题和可维护性问题
3. 实现需要保证模块/类/接口的职责单一，避免引入上帝类/上帝模块和多功能接口
4. 实现不要搞任何冗余的修改，保持修改的纯粹性，一个commit承载一个问题修改/功能实现

**执行约定**：本段随每次会话自动注入；任务执行、代码审查、验收证据均须对照上列原则逐条自检。开发原则 1 违反（无事实依据写成闭环）即流程违规；编程要求 4 违反（一个 commit 多个问题）即提交违规，由预提交钩子与 Review 把关。
