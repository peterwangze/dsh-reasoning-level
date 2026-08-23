# 决策记录 — dsh-reasoning-level

用于记录 workflow 运行中的关键决策和取舍原因。

| 编号 | 日期 | 主题 | 背景 | 决策内容 | 备选方案 | 选择原因 | 影响范围 | 决策人 | 关联任务 | 后续动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | 2026-08-23 | 中途接入声明 | 项目已运行至开发实现阶段（v0.7.0 开发中），此前无治理记录 | 中途接入（Scenario B），当前阶段=开发实现，前置阶段 Gate 标记 passed-on-entry | 从立项开始 | 项目已有 7 commits、2 个发布版本、完整 CI；补齐历史记录成本过高 | G1~G5 passed-on-entry | 用户 + Coordinator | DEV-001 | 按 standard profile 执行当前阶段治理 |
| DEC-002 | 2026-08-23 | 项目定位（G1 立项） | 多服务商模型推理等级支持差异大，逐模型手改配置繁琐易错 | 收敛为单一 `llm-reasoning` 设置项：统一默认 + 模型级覆盖 + 实时观测 | 无 | README 项目目标明确（事实） | 全部模型路由 | 项目作者（README 记载） | — | 既有事实记录 |
| DEC-003 | 2026-08-23 | 推理能力以实测为准（G2 调研） | 模型对 reasoning effort 的支持文档不可尽信 | 以实测为准：智谱 bigmodel 实测接受 max；zai/deepseek thinking 格式 off 显式发送 disabled；实测拒绝入黑名单 | 按文档声明 | README 记载的实测发现（v0.7.0 探测机制） | 能力声明/黑名单 | 项目作者 | — | 既有事实记录 |
| DEC-004 | 2026-08-23 | 技术栈与依赖策略（G3 选型） | DSH out-of-tree 插件契约 | Node.js ESM + 运行时零依赖 + 宿主包 peer `*` + bundle patch | 直接依赖宿主包版本 | CI 依赖策略 job 强制（package.json 事实：dependencies={}、peers 全 `*`） | package.json/CI | 项目作者 | — | 既有事实记录 |
| DEC-005 | 2026-08-23 | 安装通道（G4 环境搭建） | v0.6.0 前安装依赖 junction 共享树，事故加固后全面切换 | 安装全面走 `dsh plugin` 官方通道（file:/link: spec），不再 junction/手改 patch/写 settings | 旧机制 | v0.6.0 commit "official install channel, zero deps, fail-safe hooks"（事实） | install.ps1/install.sh/README | 项目作者 | — | 既有事实记录 |
| DEC-006 | 2026-08-23 | 架构分层（G5 架构设计） | 插件需要服务端适配 + 客户端设置页 + bundle 挂载 | bundle patch 层声明 + client 注入 + 服务端适配器（lib/index.js）/客户端（lib/client.js）分层 | 单文件/无 client 注入 | 仓库文件布局事实（cordis.patch.yml + lib 两文件 + dsh.client 注入四项） | 插件结构 | 项目作者 | — | 既有事实记录 |
| DEC-007 | 2026-08-23 | 接入治理与原则落地方式 | 用户通过 /governance 要求给项目加入 7 条开发原则 + 4 条编程要求 | 接入阶段=开发实现，profile=standard，模式=always-on × default-confirm；原则落地三处：AGENTS.md 注入 + docs/development-principles.md + plan-tracker 项目配置引用 | 仅文档化 / 仅 AGENTS.md | 用户 AskUserQuestion 选择（2026-08-23 本会话） | 全部后续任务执行约定 | 用户 | DEV-001 | 原则作为每次任务执行 MUST 遵守项 |
| DEC-008 | 2026-08-23 | DEV-003 范围圈定 | R1 复审遗留项 + 测试覆盖缺口（REVIEW-DEV-002-R1 §2/§6），任务启动时需用户圈定 | 范围=测试防护网核心（覆盖缺口补齐 403 门控/err 分支/30s abort + T2 $DSH_HOME + T3 CI 接入）+ N1 客户端超时对齐 + N2/N4 小修；F7/F9/F11/F12 继续遗留跟踪（维护阶段性质） | 全部遗留项本轮处理 / 仅测试不动产品代码 | 用户 AskUserQuestion 选择（2026-08-23）；依据 R1 §6 分级（N1=P2 优先，N2/N4/T2/T3=P3 小修） | DEV-003 执行边界 | 用户 | DEV-003 | QA 评估→Developer 实现→Test Reviewer+Code Reviewer 双后置审查 |
| DEC-009 | 2026-08-23 | T3 CI 依赖供给路径 + QA 新发现缺陷处置 | QA 评估三路径（devDeps 锁版/GitHub 源码/fixture stub）；QA 另发现 DEF-001（P2 IPv6 回环 403）与 DEF-002（P3 null body）圈定范围外缺陷 | T3=路径(a)：devDependencies 精确锁版（@deepseek-ai/schemastery@3.18.1 + @deepseek-ai/dsh-settings@0.1.1-rc.2，均=本机平坦树版本；CI 策略 job 只查 dependencies/peers，零依赖哲学约束运行时/发布物不受影响）；DEF-001 纳入本轮修复（gate-5 TDD 测试已就位）；DEF-002 遗留跟踪；N1 修复值按 QA 实测上界 ≥95s（7 候选/3 波×30s+5s） | 暂不接 CI / GitHub 源码 / fixture stub；DEF-001/002 均遗留 | 用户 AskUserQuestion 选择（2026-08-23）；QA 实测报告 .dev003/qa-dev003-report.md §5 | package.json(devDeps)/package-lock.json/ci.yml/lib/index.js(DEF-001)/lib/client.js(N1) | 用户 | DEV-003 | Developer 实施后 Test Reviewer+Code Reviewer 审查 |

## 使用规则

- 方案变更、范围变更、门禁变化都应进入决策记录。
- 决策记录应与计划和风险记录形成引用关系。
