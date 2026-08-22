# 证据记录 — dsh-reasoning-level

用于记录 workflow 执行过程中的关键证据，支撑任务完成与 Gate 通过。

| 编号 | 对应任务 ID | 阶段 | 证据类型 | 证据说明 | 证据位置 | 提交人 | 提交日期 | 关联 Gate | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | DEV-001 | 开发实现 | 命令输出 | 接入探索事实：git rev-list --count HEAD=7；工作区 5 文件未提交变更（README.md/VERIFICATION.md/lib/client.js/lib/index.js/package.json）；package.json version=0.7.0 | git status/log 输出（2026-08-23 会话） | Coordinator | 2026-08-23 | G6 | 接入 baseline 事实 |
| EVD-002 | DEV-001 | 开发实现 | 文档 | CI 双 job 配置存在：check（package.json/语法/依赖策略/client-smoke/资产检查）+ release（tag 触发打包+GitHub release） | .github/workflows/ci.yml | Coordinator | 2026-08-23 | G6/G7 | 已有防护网 baseline |
| EVD-003 | DEV-001 | 开发实现 | 文档 | 无单元测试目录/文件（glob 探test/spec 无结果）；仅 scripts/client-smoke.mjs（7.6KB）冒烟脚本 | 仓库目录扫描（2026-08-23） | Coordinator | 2026-08-23 | G6 | RISK-001 依据 |
| EVD-004 | DEV-001 | 开发实现 | 文档 | 事实依据：docs/development-principles.md 新建（含用户 2026-08-23 提供的 7+4 条原则原文）；AGENTS.md 末尾追加『项目开发原则』段；plan-tracker 项目配置含 docs/development-principles.md 引用。验收命令 `python -c "...三处产物断言..."` 输出 DEV-001 acceptance PASS（exit 0），断言 7+4 条原文逐条存在。目标对齐：原则约束未来所有开发/审查/验收工作——对应 7 条开发原则的强制执行机制（事实为准/测试看护/泛化/质量/安全）。用户影响：获得=每次 DSH 会话自动注入原则段；感知=AGENTS.md 新增『项目开发原则』段；体验变化=否（对既有功能/行为无影响）。结构化事实：{"commands":[{"cmd":"python -c \"...dev-001 acceptance...\"","exit_code":0,"summary":"DEV-001 acceptance PASS","log_path":"terminal output"}],"files_changed":["docs/development-principles.md","AGENTS.md",".governance/plan-tracker.md"],"diff_summary":"新增原则文档+入口段+跟踪引用","review":{"conclusion":"NOT_REQUIRED","reviewer":"Coordinator（治理记录任务，无产品代码改变）"}} | docs/development-principles.md、AGENTS.md、.governance/plan-tracker.md | Coordinator | 2026-08-23 | G6 | 治理记录交付（审查状态=不需审查） |

## 使用规则

- 已完成事项必须至少有一条证据。
- Gate 结论必须可追溯到证据。
- 产品代码交付证据必须包含 `事实依据:`、`目标对齐:`、`用户影响:`。
- 治理记录类交付（docs/原则等）证据只需事实锚点（文件路径 + 命令输出）。

| RECO-DEV-001 | DEV-001 | 治理记录 | task-priority-analysis 机器写入完成必推荐调用快照（trigger DEV-001，M7.4 step 6 / FIX-262） | 事实依据：task-priority-analysis 输出摘要（机器写入） | 3 tasks/1 completed/2 unblocked/0 blocked/0 non-exec | Coordinator | 2026-08-23 | G11 | N/A |
