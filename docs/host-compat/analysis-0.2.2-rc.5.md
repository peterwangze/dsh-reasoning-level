# DSH 0.2.2-rc.5 兼容性实证分析报告

> Task: MAINT-043/044 + FEAT-008 诊断基础 | 项目: dsh-reasoning-level v0.10.0 | 核对日期: 2026-11-19（Coordinator 逐项实证）
>
> 本报告所有结论均来自 2026-11-19 的逐项实证（静态面 + 活体运行实例），证据位置照抄核对记录，未含任何未验证断言。宿主代际跨度：0.2.2-rc.1（上轮验收基线，MAINT-042/EVD-084）→ **0.2.2-rc.5**。

## 1. 环境事实（升级后布局剧变）

| 项 | 事实 | 证据 |
|---|---|---|
| 宿主版本 | 桌面运行时元包 `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.5`（全部依赖同代 0.2.2-rc.5，共 300+ 包） | `D:\app\dsh\resources\app.asar` 内 `dsh/package.json`（DSH read 工具直读归档） |
| 宿主包树位置 | **全量内化 app.asar 归档**（209,083,008 字节）；文件系统不再存在 node 可直读宿主树 | `app.asar` 为文件非目录（原生 pwsh ENOENT 实证）；归档头解析提取成功 |
| 归档提取 | 自研零依赖读取器（tmp/extract-asar.mjs 原型）：三级 pickle 头〔payload=4@0 / 头总长@4 / 头载荷长@8 / JSON 长@12 / JSON@16〕，blob 基址 = 8+头总长；`dsh/node_modules` 前缀提取 18,896 文件（179.7MB）+ 1,666 unpacked 条目（自 `app.asar.unpacked` 拷贝），**零缺失** | 提取日志 + 抽验 15 关键包 package.json |
| 关键传递依赖升级 | cordis 4.0.5→**4.1.0**、schemastery 3.18.5→**3.19.0**、cosmokit 1.8.6→1.9.0、cordis-plugin-group/include/loader 1.0.x→1.1.0、timer 1.1.7→1.2.0 | 提取树 package.json 实测 |
| `~/.dsh/profiles/node_modules`（旧缺省活树） | **陈旧幻影**：@deepseek-ai 作用域 241 项全部为 junction（2026-11-19 复核时点；本报告初稿时为 227 实目录 + 15 junction，其后再装载已全部投影为 junction）、目标均为 npm 全局 dsh@0.2.1-rc.2 嵌套树；对它跑 doctor 得 12/12 假 PASS（fail-open） | Get-ChildItem 枚举 + junction LinkType/Target 实测 + doctor 实跑 |
| profile 本地树 | `profiles\desktop\node_modules\@deepseek-ai` 为**空目录**（0 项）；.pnpm 无 deepseek 条目；profile 仅含 link: 插件 junction（dsh-reasoning-level → 本工作区，desktop+web 双 profile） | Get-ChildItem -Force 计数 + .package-map.json |
| `~/.dsh/dsh-runtimes\dsh-primary-runtime` | 语言工具链载荷（runtime.json：node 24.21.0 / pnpm 11.28.5 / python 3.12.14），**不是**宿主包树 | runtime.json + dependencies/{node,pnpm,python} |
| peer 解析机制 | 插件活着且 contractHealth.ok=true，而文件系统无 @deepseek-ai 可解析树 ⇒ peer 解析由宿主加载器内部机制完成（app.asar 树 + 新包 `dsh-lazy-require` + `dsh-cordis-host-runner`）——**隐形依赖面，此前无档案**（FEAT-008 收敛） | 运行实例证据 + 归档依赖清单（dsh-lazy-require@0.2.2-rc.5 新增） |
| npm 可得性 | `@deepseek-ai/dsh-settings@0.2.2-rc.5`、`cordis@4.1.0`、`schemastery@3.19.0` 均已发布 | npm view 实测 |

## 2. 兼容性判定矩阵（四重独立证据，全部通过）

| # | 证据面 | 结果 | 细节 |
|---|---|---|---|
| 1 | host:doctor × 12 探针，目标 = **真实 0.2.2-rc.5 提取树**（绝对路径） | **12/12 PASS，0 漂移** | 事件 ×5（settings/document-updated@L435、agent/request@L1007、agent/request-error@L942、agent/status@L571、llm/stream@L2508）；api-remotes 方法集含元数表全对齐；resolveCallWithInfo effort 校验（L2293）；webServer exact 路由（L376-378）；agent-loop native 代守卫（L1013）+ `agent.model.select`（L1403）/`model.current()`（L684）窗口成立；schemastery 3.19.0 使用面全 function；客户端 bundle 镜像单源一致；inject 三声明在树可解析 |
| 2 | 运行中实例（127.0.0.1:58134，升级后当日） | `contractHealth.ok=true`、`missing=[]`、`agentSelection.mode=native` | 插件自带运行时契约自检（MAINT-036/042 建立的 fail-loud 观测面） |
| 3 | 插件 HTTP 端点 | `/reasoning-level-stats` 200、`/reasoning-level-models` 200 | 四端点挂载正常（MAINT-038 inject 修复后形态） |
| 4 | 注入链实测 | 升级后当日 totalCalls=114,324；各路由 `max` 生效（glm-local/glm-5.3 6750×max、deepseek-official 1870×max 等），无 UNSUPPORTED_REASONING_EFFORT 回归 | stats 面板实测数据 |

**结论：v0.10.0 对 DSH 0.2.2-rc.5 功能性兼容成立，零产品代码改动**（继 0.2.1-rc.2→0.2.2-rc.1〔MAINT-042 后的 FEAT-006 体系〕、0.2.0→0.2.1〔MAINT-037〕之后，解耦体系第三次实战达成）。主树回归基线 `node --test` 246/246 全绿。

## 3. 看护体系三缺口（本轮优化靶点，DEC-034）

1. **G1（P0）doctor 活树探测失效（fail-open）**：缺省解析落在陈旧幻影树（0.2.1-rc.2），本轮 12/12 假 PASS——与 MAINT-030 溜号同型。附带缺陷：`--tree` 相对路径触发探针 #4 `createRequire` 崩溃（绝对路径正常）。→ **MAINT-043**：asar 感知活树源（自动定位/提取/缓存 + 脏检查）+ 旧缺省 STALE 醒目警示 + 绝对路径归一。
2. **G2（P0）回归栅栏缺新代**：双树 = 0.2.1-rc.2（主树，最老支持代）+ 0.2.2-rc.1（compat 镜像）；cordis 4.1.0 / schemastery 3.19.0 / 0.2.2-rc.5 全套不在任何栅栏。→ **MAINT-044**：镜像树轮换 rc.1→rc.5（DEC-034：轮换非三树），主树不动。
3. **G3（P1）加载器接缝无档案**：桌面时代 peer 解析完全依赖宿主加载器内部机制（dsh-lazy-require 新包 + dsh-cordis-host-runner + app.asar 树），该接缝不在 HOST_PROVENANCE 台账、无探针、contractHealth 无观测——宿主若改它，当前是盲区。→ **FEAT-008**：解析契约锚点化（S13）+ 探针 #13 + contractHealth peer 观测。

## 4. 与上轮（0.2.2-rc.1，MAINT-042）差异面

- 宿主包 227→338（+111：plugin-manager/market 系、experimental 系、agent-preset 拆分改名等）；插件已声明触点零漂移。
- 事件/方法/校验面锚点行号整体位移（如 agent/request L1191→L1007）但语义结构未变——doctor 按锚串而非行号判定，不受影响。
- 0.2.2-rc.1 引入的 native 代守卫（agent/request 不得步骤后改写 reasoningEffort）在 rc.5 存续；插件的 `agent.model.select()` 原生选择路径继续有效（运行实例 mode=native 实证）。

## 5. 状态

- 诊断面：**终稿**（本报告；12 探针判定于诊断时点，MAINT-043/FEAT-008 落地后探针总数 13）。
- 修复任务：MAINT-043 已实施（commit `adf512a`，272/272，doctor v2 无参实测走 asar 层 12/12 + 返工进行中〔R0 P2 Zip-Slip 闭环〕）；MAINT-044 已实施（镜像树 `tmp/compat-022rc5` 246/246 + doctor 12/12，commit `d6f16a8`）；FEAT-008 已实施 + 返工闭环（commit `90b46f2` + `50dee33`，主树/镜像树双 281/281，探针 #13 三树形态：asar 树 13/13、主树 12+1SKIP、镜像树 13/13 部分在场）。Code Reviewer R0 **APPROVED_WITH_NOTES / unresolved_blockers=0**。
- 发布：无产品代码缺陷，不发布适配补丁；若 MAINT-043/044/FEAT-008 交付需随版出仓，另行授权（DEC-034）。
