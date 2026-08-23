# dsh-reasoning-level

本项目使用 `software-project-governance` workflow 管理项目治理。

## 项目配置

- **项目名称**: dsh-reasoning-level
- **项目目标**: DeepSeek Harness（DSH）统一推理等级插件——一个 `llm-reasoning` 设置项动态管理所有模型的默认思考强度（含模型级默认与实时调用观测），只写入模型实测支持的等级，杜绝 `UNSUPPORTED_REASONING_EFFORT`
- **Profile**: standard（完整 11 阶段 Gate + 审查路由；已发布 GitHub 插件 + 用户质量优先原则）
- **触发模式**: always-on
- **操作权限模式**: default-confirm
- **工作流版本**: 0.75.0
- **当前阶段**: 开发实现（第 6 阶段）——用户 B3 确认调整，2026-08-23 接入
- **接入方式**: 中途接入（Scenario B，2026-08-23）
- **项目原则**: `docs/development-principles.md`（相对 `.governance/` 为 `../docs/development-principles.md`）——7 条开发原则 + 4 条编程要求，MUST 遵守（DEV-001 落地，2026-08-23）

## Onboarding 声明（中途接入）

- **前置阶段（1~5）Gate**: 全部标记为 `passed-on-entry`
- **当前阶段（6）Gate**: G6 pending，待开发阶段任务推进后检查
- **已补齐的前置阶段关键决策**: DEC-002~DEC-006（每个前置阶段 1 条，见 decision-log.md）

## Gate 状态跟踪

| Gate | 阶段转换 | 状态 | 通过日期 | 关键证据 |
| --- | --- | --- | --- | --- |
| G1 | → 调研 | passed-on-entry | 2026-08-23 | DEC-002：项目定位为单一 llm-reasoning 设置项 |
| G2 | → 技术选型 | passed-on-entry | 2026-08-23 | DEC-003：推理能力支持以实测为准 |
| G3 | → 环境搭建 | passed-on-entry | 2026-08-23 | DEC-004：Node ESM + 零运行时依赖 + peer `*` |
| G4 | → 架构设计 | passed-on-entry | 2026-08-23 | DEC-005：安装全面走 dsh plugin 官方通道 |
| G5 | → 开发实现 | passed-on-entry | 2026-08-23 | DEC-006：bundle patch 层 + client 注入 + 服务端/客户端分层 |
| G6 | → 测试 | pending | | |
| G7 | → 防护网与CI/CD | pending | | |
| G8 | → 版本发布 | pending | | |
| G9 | → 运营 | pending | | |
| G10 | → 维护 | pending | | |
| G11 | → 下一轮 | pending | | |

## 项目总览

| 项目 | 当前阶段 | 总任务数 | 已完成 | 阻塞中 | 关键风险数 | 最近 Gate 结论 | 最近复盘日期 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dsh-reasoning-level | 开发实现（v0.7.0 开发完成，待发布决策） | 3 | 3 | 0 | 1 | 无（G6 可评估：29 用例防护网+CI 接入） | — |

## 当前活跃事项

> **接入说明**：2026-08-23 `/governance` Scenario B 半途接入。探索事实：7 commits、tags v0.5.0/v0.6.0、package.json v0.7.0、工作区 5 文件未提交变更、CI 双 job（check+release）、无单元测试（仅 client-smoke 冒烟脚本）。

| 优先级 | ID | 事项 | 依赖 | 目标版本 | 闭环路径 | 状态 |
|--------|----|------|------|---------|---------|------|
| **P0** | DEV-001 | 落地项目开发原则与编程要求（7 原则 + 4 编程要求：AGENTS.md 注入 + docs/development-principles.md + plan-tracker 项目配置引用） | — | 0.7.0 | 治理记录范畴（docs/** 与 .governance/** 为治理记录，Coordinator 直写，审查状态=不需审查） | ✅ 完成 (2026-08-23)——三产物落地（docs/development-principles.md 新建 + AGENTS.md『项目开发原则』段追加 + plan-tracker 项目配置引用），验收命令输出 DEV-001 acceptance PASS（EVD-004） |
| **P1** | DEV-002 | v0.7.0 工作区未提交变更整理与提交（README.md/VERIFICATION.md/lib/client.js/lib/index.js/package.json 共 5 文件）——提交需遵循"一个 commit 一个问题"原则（见开发原则 编程要求 4） | DEV-001 | 0.7.0 | 治理记录 + 产品代码（含产品代码 commit 按变更分组；M7.4 提交任务） | ✅ 完成 (2026-08-23)——7 提交（c157085+33a071e 分组、4107cb3/a15d26a/6d730e1/441d9b4/e3a21d1 返工）；审查=已审查（R0 NEEDS_CHANGE→返工→R1 APPROVED_WITH_NOTES unresolved_blockers=0，EVD-005 + REVIEW-DEV-002-R0/R1）；验证 node --check×2/client-smoke/node --test 8/8 全 exit 0 |
| **P1** | DEV-003 | 测试防护网评估与补齐（用户 2026-08-23 圈定范围 DEC-008/009：核心测试补齐 + T2 + T3[devDeps 锁版] + N1/N2/N4 + DEF-001；DEF-002/F7/F9/F11/F12 遗留） | DEV-001 | 0.7.0 | QA 评估✅（25/3/0）→ Developer 实现✅（5+4 提交）→ 双 Reviewer 终态：Test Reviewer R0=APPROVED_WITH_NOTES unresolved_blockers=0；Code Reviewer R0=NEEDS_CHANGE（D1+T3-1）→ 返工→ **R1 APPROVED_WITH_NOTES unresolved_blockers=0**（8e75348 P2-01 收尾核验：仅注释级，终态有效） | ✅ 完成 (2026-08-23)——node --test 29/29 exit 0；npm ci 正反实证；审查=已审查（双线终态，EVD-006 + REVIEW-DEV-003-R0/R1/test-R0） |

### 最近完成

（2026-08-23 接入首日——首个完成记录：）

| 任务 ID | 描述 | 完成日期 | 证据 |
| --- | --- | --- | --- |
| DEV-001 | 落地项目开发原则与编程要求（AGENTS.md + docs/development-principles.md + plan-tracker 引用） | 2026-08-23 | EVD-004 |
| DEV-002 | v0.7.0 变更分组提交 + R0→R1 审查闭环（NEEDS_CHANGE→返工→APPROVED_WITH_NOTES unresolved_blockers=0） | 2026-08-23 | EVD-005 + REVIEW-DEV-002-R0/R1 |
| DEV-003 | 测试防护网（29 用例+CI 接入）+ N1/N2/N4/DEF-001/D1 修复 + 双 Reviewer 终态（Code R1 + Test R0 均 APPROVED_WITH_NOTES unresolved_blockers=0） | 2026-08-23 | EVD-006 + REVIEW-DEV-003-R0/R1/test-R0 |

## 版本规划

### 版本路线图

| 版本 | 状态 | 预计日期 | 核心范围 | 包含任务 | 关键交付物 |
| --- | --- | --- | --- | --- | --- |
| 0.7.0 | 进行中（工作区未提交） | 待定 | 一键探测并固化配置、黑名单/能力声明持久化、探测可用性修复 | DEV-001, DEV-002, DEV-003 | release tag + 文档更新 |

### 版本 Gate（V-Gate）

| Gate | 检查项 | 状态 |
| --- | --- | --- |
| V-Gate 1 | 全部计划任务完成且有证据 | pending |
| V-Gate 2 | 独立审查通过（产品代码变更） | pending |
| V-Gate 3 | release 资产（README/VERIFICATION 更新 + tag） | pending |

### 版本规划纪律

- 版本内容变更（范围增减）必须经用户确认并记录到 decision-log。
- 已发布版本（v0.5.0/v0.6.0）历史为既有事实：tag 存在、CI release job 已用；此次接入不回补历史 Gate。

### 版本里程碑

| 里程碑 | 目标日期 | 版本 | 状态 |
| --- | --- | --- | --- |
| v0.7.0 候选 | 待定 | 0.7.0 | 未开始 |

## 需求跟踪矩阵

| 需求ID | 描述 | 来源 | 优先级 | 关联任务 | 当前状态 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ-001 | 统一默认推理等级（路由级，全部模型支持时才写入） | README.md 项目目标/功能特性 | P1 | 既有功能（v0.2.4~v0.7.0 已实现） | 已实现（既有事实） | 手动/冒烟 |
| REQ-002 | 模型级默认 `models: {"provider/model": level}` + 按实测能力过滤选项 | README.md 功能特性 | P1 | 既有功能 | 已实现（既有事实） | 手动/冒烟 |
| REQ-003 | 实时调用观测（等级/tokens/耗时/来源）与统计持久化 | README.md 功能特性 | P1 | 既有功能 | 已实现（既有事实） | 手动/冒烟 |
| REQ-004 | 一键探测并固化配置（v0.7.0）——实测可用等级写回能力声明、拒绝等级入黑名单 | README.md v0.7.0 | P1 | DEV-002（提交） | 实现中（工作区未提交） | client-smoke + 手动 |

## 变更控制（临时任务纳入机制）

### 纳入流程（两条路径）

1. **快速通道**（仅治理记录）：用户临时要求修改 `.governance/**`、`docs/**`、`project/references/**` → 直接在 plan-tracker 记账后执行，无需 Gate。
2. **标准通道**（产品代码/范围变化）：临时任务入账（优先级判定 → 版本适配 → 冲突检查 → 版本范围更新）→ 安排执行 → 完成后补证据 → 产品代码变更后置独立审查。

### 变更控制纪律

- 任何新任务 MUST 先出现在本 plan-tracker 再动手（M7.5）。
- 范围变更、架构决策、发布决策必须经用户确认（AskUserQuestion）并记入 decision-log。
- 一个 commit 承载一个问题/功能（编程要求 4）。

## 使用规则

- 所有 agent 必须复用同一份主计划。
- 已完成任务必须补齐证据。
- 发生偏差时必须更新风险或决策记录。
- 阶段切换前必须先检查 Gate。
