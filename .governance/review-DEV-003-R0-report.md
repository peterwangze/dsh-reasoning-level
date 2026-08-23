# 代码审查报告 — DEV-003：产品代码变更独立审查（Round R0）

## 0. 报告头部

| 字段 | 值 |
|---|---|
| Task ID | DEV-003（产品代码部分；测试设计质量由并行 Test Reviewer 负责，本报告仅审产品↔测试衔接） |
| Round | **R0**（前轮引用：DEV-002 R1 报告 review-DEV-002-R0-report.md/R1 结论 APPROVED_WITH_NOTES + 遗留清单 N1/N2/N4/DEF-001/T2/T3——本任务即其后续） |
| Review Agent | Code Reviewer（只读） |
| 审查对象 | f0021c8..HEAD 产品代码与配置（e349d88 N1+N2 client.js；8b42272 N4 index.js；0700125 DEF-001 index.js；4c6c96f T3 package.json/package-lock.json/ci.yml；4ecaf93 test/** 仅衔接审） |
| 事实源 | .dev003/dev003-product.diff（已通读 1007 行；与 HEAD 抽查一致） |
| **审查结论** | **NEEDS_CHANGE**（P0 阻塞 = 0；P1 关键 = 2；修复后进入 DEV-003 R1 复审） |

## 1. 逐项审查结论

### N1（e349d88）：已修复，正确
- `PROBE_FETCH_TIMEOUT_MS = 95000`（client.js:141）。推导验证：候选上界 = LEVELS 全 7 档（index.js:62，目录声明可含 xhigh）→ ceil(7/3)=3 波 × 30000 + 5000 = 95000 ✓；AbortController 用法正确（client.js:203-219）。注释完整记录推导依据 ✓。

### N2（e349d88）：已修复，正确
- `setProbeSummaryOk(true)` 置于 guard 之后、异步体启动之前（client.js:194-197）——所有实际入口均覆盖；重入被 guard 挡回，无状态竞态。

### N4（8b42272）：已修复，达成双引擎目标
- 新 schema（index.js:111）：`z.dict(z.dict(z.union([z.string(), z.const(null)]), z.string()), z.string())`。schemastery 3.18.1 逐项验证：union 成员均为 Schema 实例 → Schema.from 原样返回，**不再触发 Schema.from(null)→any() 退化** ✓；'disabled'→string 通过；null→顶层 nullable 直通；123/true/{}/数组→拒绝 ✓；严格引擎下由 const(null) 兜住 ✓。注释（index.js:105-108）与行为一致（"string 分支放行 null"表述微瑕，P3 不改）。

### DEF-001（0700125）：IPv6 修复正确，**但引入安全边界回归 D1（P1）**
- 旧缺陷证实：`'[::1]:8080'.split(':')[0]`='['；`'::1'.split(':')[0]`=''——旧实现从未识别 IPv6 回环。
- 新实现（index.js:770-780）：URL hostname 剥括号正确判定 [::1]:8080/[::1]/localhost:8080/127.0.0.1:3000 ✓；裸 ::1 catch 回退 ✓；gate-5 三形态与实现逐一对上 ✓。
- **D1（P1，新引入）**：URL 归一化把 Host 头 userinfo/path/fragment 段归一化掉——`Host: 127.0.0.1/x`、`Host: x@127.0.0.1`、`Host: 127.0.0.1#y` → hostname 均为 127.0.0.1 → **非回环来源可伪造 Host 头绕过 statsPublic=false 门控**（旧实现对这些形态一律 403——行为回归）。可被绕过面 = stats 读 + /probe（LLM 成本）+ /probe/apply（配置写入）。DSH webserver 支持 0.0.0.0 绑定（dsh-host-webserver/lib/index.js:99，已核实）——0.0.0.0 + statsPublic=false 即文档承诺"LAN 不可见"边界，被 D1 打破。修复：URL 解析前对原始 host 字符集预检 `if (/[^a-z0-9.:[\]-]/.test(host)) return false`（浏览器合法 Host 头不含 @/#/%/空格，无误伤）；三种恶意形态补入 gate 测试矩阵。

### T3（4c6c96f）：import 链正确，**但 CI 处方与锁/本地树不一致 T3-1（P1）**
- 核实通过：devDeps 三包恰好覆盖实际 import 链（dsh-settings 仅模块级 import cordis——node_modules 内全文件 grep 证实，dsh-brand/dsh-invariants 声明 peer 但从未 import）；6 包 lock 完整；package.json 契约保持（dependencies {} ✓、peers 4 者 * ✓、devDeps 3 包精确锁版无 ^ ✓、test/ 未入 files ✓）；ci.yml 步骤位置合理，node --test 默认发现命中 8 个 *.test.mjs 不误跑基建文件 ✓。
- **T3-1（P1）**：工作区 node_modules 实证 = 恰 4 个 @deepseek-ai 包（无 dsh-llm/dsh-brand/dsh-invariants）——证明本地用了 --legacy-peer-deps；ci.yml `npm ci --ignore-scripts --no-audit --no-fund` **无该 flag** → npm ≥7 默认 auto-install-peers 尝试补齐 3 个非 optional peers（不在 lock）→ 与 npm ci 锁严格同步冲突，大概率 ERESOLVE/锁不同步失败（静态证据链强；执行级证实留待 CI 实测）。修复：ci.yml 补 `--legacy-peer-deps`，README 记录处方与根因（peers 全 * = 运行时 DSH 树解析，测试仅需 import 链三包）。

### test/** 衔接（仅衔接视角）
- 各断言与产品语义逐一对上（gate-1..5/err-1..5/timeout-1/concurrency-1/schema N4/T2/N1/N2 元测试）——无恒真/无弱断言/无产品路径 mock 泄漏。
- 两处衔接缺口（P3）：① gate-4 未覆盖 D1 恶意 Host 形态（并入 D1 修复）；② TDD-FAILS-UNTIL 注释已过时（修复后未更新为守卫语义表述）。

## 2. 五维 + AI 专项
- 正确性：N1/N2/N4 正确；DEF-001 目标正确但引入 D1；T3 引入 T3-1。
- 安全性：D1（Host 头注入类网关旁路）；::ffff:127.0.0.1 未识别（与旧一致，P3 记录）。
- 可维护性：注释质量高；N4 注释微瑕（P3）。
- 性能：95s 与服务端 90s 最坏对齐（+5s 裕量）✓。
- 测试覆盖：8 文件覆盖 R1 缺口；唯一缺口=D1 恶意形态（并入 D1）。
- AI 专项：mock 残留无/硬编码无/幻觉 API 无/TODO 无/过度实现无。

## 3. 发现清单
- **P0：0**
- **P1：2**——D1（Host 头归一化旁路，修复=字符集预检+测试矩阵补 2 用例）；T3-1（npm ci 缺 --legacy-peer-deps，CI 门禁目的未达成）
- **P2：2**——T2 验证通过记录；N4 严格引擎真值不可验证边界（可接受）
- **P3：~5**——D1 测试缺口（并入 D1）；TDD 注释过时；N4 注释表述；::ffff: 记录；非法端口 403 收紧（正效应记录）；e349d88 合并 N1+N2（讨论级）

## 4. 设计一致性（dev-principles）
原则 2 违反（D1——URL 归一化推演不全面）；原则 3 违反（D1 行为回归：旧拒绝→新放行）；原则 7 违反（D1 削弱安全边界——第 7 条点名风险形态）；原则 1 基本遵守（D1 为事实分析缺口）；原则 4/5/6 达标（除 T3-1 交付瑕疵）；编程要求 1/2/3 达标；编程要求 4 基本达标（e349d88 合并 N1+N2 讨论级）。

## 5. 硬门槛自检
P0=0 ✓；5 维度全覆盖 ✓；发现 100% 标级（0×P0/2×P1/2×P2/~5×P3）✓；设计一致性完成 ✓；AI 专项完成 ✓；只读约束遵守（npm ci 行为为静态证据链推演，未实测——已注明）✓。

## 6. 复审提示
NEEDS_CHANGE（R0，DEV-003）：退回 Developer 修复 **D1（必须）** 与 **T3-1（必须）**，P2/P3 入跟踪表；随后重 spawn 同一 Code Reviewer 复审（R1）逐条标注。不建议有条件合并——D1 是安全边界回归、修复一行、已被公式化（预检+测试矩阵），修复成本 < 缺陷遗留成本，且直接关系用户原则 7。最终处置权在 Coordinator。
