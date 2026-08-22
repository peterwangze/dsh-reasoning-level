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

## 使用规则

- 方案变更、范围变更、门禁变化都应进入决策记录。
- 决策记录应与计划和风险记录形成引用关系。
