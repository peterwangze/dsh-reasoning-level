# Changelog

## 0.7.7 (2026-09-12)

### Fixed
- **手写全量声明的自定义 wire 不再被固化覆盖（MAINT-019 P2-1，保 wire 红线）**：用户恰好**手写 7 键全量能力声明**、且其中任一档 wire 与标准值不同（典型：openai 系路由手写 `off: 'disabled'`）时，形状判定仅按 key 集识别，把这份**手写**声明误判为「本插件生成」——一键探测的固化/收敛随即以标准 wire 整体替换，用户自写的 wire 被悄悄覆盖（违背「用户手改的配置永不被覆盖」承诺）。现 7 键判定叠加**逐键 wire 标准性校验**（基准 = 本插件生成表），任一键 wire 非标准即判为手写、走并入语义（保留原 wire + 实测可用档位追加）——**手写全量声明自此与其它手写声明同等待遇**；6 键 / 5 键生成形状判定不变（wire 过期正是旧生成声明待升级的信号）。
- **levels 筛选探测不再缩档替换原声明（MAINT-019 P2-3）**：带 `levels` 筛选调 `/probe` 时，探测以筛选子集为 working 集触发固化收敛，把模型声明的全量档位**缩水**成筛选子集（一次带筛选的探测即可削掉声明里的等级）。现筛选探测只测量不固化——探测照常执行并如实返回结果，探测窗口内写过的全量声明回滚为探测前原声明，结局如实标注「待应用（pending-apply）」而非误报已固化，也不落成持久化错误。

### Added
- **探测/诊断看护加固（MAINT-031 + MAINT-034，面向开发者与排查者）**：①host-doctor 事件锚探针的「全不可解析」判定基由锚点数改为**派生去重包集**——修前该分支恒不可达，整树不可解析时误报部分命中（「可解析包的锚点全部命中」）把排查方向带偏；②新增「回滚写失败」分支看护（注入第 2 次写入抛错 → 断言结局为持久化错误、声明停在探测临时全量形状；不注入的同夹具对照走「待应用」，非空转）；③该「全不可解析」文案入 host-face-contract 断言（旧判定基下可判红，防回退）。

### Changed
- **文档口径与事实修正（MAINT-031 ②⑤ + MAINT-033，纯文档、行为零变更）**：analysis-0.1.5.md §1 元包发布时间戳改配元包自身实测时刻并标注归属（修前误用工作区包的发布时刻）；`docs/host-compat/` 两文件内日期口径统一为权威日期 2026-09-12（共 11 处）；本 CHANGELOG 0.7.6 段标题行日期更正为 **2026-09-12**（修前误作次日；权威依据 = git 提交链 + 系统时钟；该行同时是 GitHub Release v0.7.6 body 的事实源，随后刷新）。lib/index.js 两处推断性注释改为事实表述、测试注释引用的源码行号刷新至当前实际（判定逻辑零改动）。
- 无 breaking changes；无用户数据迁移、无设置 schema 变更；运行时依赖策略不变（dependencies 恒空、peers `*`）；无 Feature Flag 变更。
- 版本号 0.7.6 → 0.7.7（PATCH：两项探测/固化缺陷修复 + 看护与文档修正，无新用户功能面、无 breaking、无运行时依赖变更）。

### Notes
- **升级注记**：0.7.6 → 0.7.7 **无用户数据迁移、无设置 schema 变更**；两项修复只作用于「手写 7 键全量声明 + 自定义 wire」与「带 levels 筛选的探测」这两个具体形状，未命中者行为完全等价（其余路径零改动）——升级即得，无需任何用户操作，已按 0.7.6 产生持久化数据的用户亦无需处理。
- **向后兼容（回退安全）**：本版零新增持久字段、零设置 schema 变更，回退 0.7.6 无冲突。
- 已知遗留：①MAINT-032（P3）——`/probe/apply` 无 filter 语义：外部 API 客户端若把带筛选的探测结果回传该端点，仍会按「实测即真值」写入该子集（内置客户端不发送筛选参数，故当前无用户面暴露；**若未来 UI 增加筛选入口，此 P3 应升级**）；②所有权台账 `llm-reasoning.applied` 在同帧多路径写入下的理论竞态（0.7.5 起登记，有自愈路径，加固待排期）；③审查记录级 P3 备忘若干（含 host-probes 部分命中分支文案暂无持久看护）。
- 发布范围 = MAINT-019 + MAINT-031 + MAINT-034 + MAINT-033（9b1f9bf / 152309a / dc47d42 / 版本收口与 CHANGELOG 日期口径）；质量依据：各任务审查全闭环（Code Reviewer 终态 APPROVED_WITH_NOTES unresolved_blockers=0）+ 全量回归 87/87 + client-smoke 5 组件 + host-doctor 活树（0.1.5-rc.2）11/11 PASS + `npm pack` 资产核验（total 9）+ **用户真机验收通过**（源码路径安装态 = v0.7.6 + MAINT-019/031 补丁，四项验收〔页面渲染 / 按钮写路径 / 探测固化 / 注入链无 `UNSUPPORTED_REASONING_EFFORT`〕全正常；v0.7.7 严格 tag 内容的真机验收于发布后执行）。

---

## 0.7.6 (2026-09-12)

### Added
- **宿主兼容看护体系（FEAT-002，面向源码仓库开发者）**：①判别测试升级为**双工件源**——工件源① devDeps 锁版基线（CI 恒断言、fail-closed），工件源② `DSH_HOST_TREE` 环境变量指向活宿主树（在场即断言、缺席逐条显式 SKIP）——逐触点以真实宿主工件断言（导出面 / 函数逐字节 / 事件名存续 / RPC 方法集与元数 / effort 校验结构），杜绝「测试桩抄适配层假设自证」的 mock 假绿；②新增 `npm run host:doctor` 一条命令诊断——11 条触点 PASS / FAIL / DRIFT / SKIP 逐项表 + 宿主版本清单 + 漂移定位建议（分钟级、全程只读），与 CI 判别测试共用同一探针模块（判据零分叉）；③devDeps 基线增锁 `@deepseek-ai/dsh-agent-loop` / `dsh-llm` / `dsh-host-webserver`（@0.1.2-rc.1，非运行时依赖）——事件名 / 校验结构 / webServer 面全部落入 CI 基线断言域。**dsh 升级的兼容问题发现路径从「用户报障」提前到「doctor 一跑 + CI 判别测试当日红」**。
- **doctor 零执行守卫收口（MAINT-030）**：host-doctor 指向的宿主树零断言执行（如空作用域树）时退出码 2 fail-closed——修复空树误报健康（exit 0）的溜号窗口；随修坏树扫描输出透传、异常结构化报错、残树归因分级（SKIP-UNRESOLVED ≠ 契约 FAIL）。

### Changed
- **宿主依赖边界架构演进（FEAT-001，内部架构演进、行为等价）**：对 DSH 宿主的全部契约性依赖（事件名 / 服务名 / 命名空间接缝 / RPC 方法面 / 元数 / 信封形状）收敛到单一模块 `lib/host-compat.js`（客户端面为 `lib/client.js` 内嵌镜像段，机器锚定两平面一致），每条触点携带宿主出处台账（包名 + 版本 + 源码行）——**dsh 升级适配的改动面收敛到「单模块 + 镜像段 + devDeps 锁版行」单点**。运行时行为零变更。
- **dsh 0.1.5-rc 兼容性实证与声明面清理（MAINT-029）**：v0.7.5 全部宿主触点经 0.1.5-rc.2 宿主树逐项静态核对**全兼容**（dsh-settings 导出面一致、`parseSettingsNamespace` 函数体逐字节一致、4 事件名存续、api-remotes settings RPC 7 方法集一致、effort 校验结构未变、传递依赖字节级一致——报告 `docs/host-compat/analysis-0.1.5.md`）；并移除自首版遗留的 `@deepseek-ai/dsh-client-runtime` **死 inject 声明**（0.1.5 宿主树不存在该包、原生 client 插件均不声明——清理后 inject 对齐原生最小集）。
- 无 breaking changes；无用户数据迁移、无设置 schema 变更；运行时依赖策略不变（dependencies 恒空、peers `*`）；无 Feature Flag 变更。
- 版本号 0.7.5 → 0.7.6（PATCH：兼容性实证 + 内部架构演进 + 看护工具，无新用户功能面、无 breaking、无运行时依赖变更）。

### Notes
- **升级注记**：0.7.5 → 0.7.6 **无用户数据迁移、无设置 schema 变更、行为等价**（内部架构演进）——升级即得，无需任何用户操作。已知边界：`npm run host:doctor` 为**源码仓库开发态工具**（npm 安装包不含 scripts/，需在源码仓库内运行；README 已明示）。
- **向后兼容（回退安全）**：本版零新增持久字段、零设置 schema 变更，回退 0.7.5 无冲突。
- 已知遗留：MAINT-031（P3：probeEventNames 不可达分支文案 + 分析报告时间戳标注小修，后续版本处理）。
- 发布范围 = MAINT-029 + FEAT-001 + FEAT-002 + MAINT-030 + DOC-002（910baed / 798b874 + 582d358 / b473976 + f369e7f / f393921 / a0ef3d6 + 版本收口）；质量依据：各任务审查全闭环（Code / Design / Test Reviewer 终态 APPROVED_WITH_NOTES unresolved_blockers=0）+ 全量回归 80/80 + client-smoke 5 组件 + host-doctor 活树（0.1.5-rc.2）11/11 PASS + `npm pack` 资产核验（total 9）。

---

## 0.7.5 (2026-09-06)

### Fixed
- **探测结果不保留修复（MAINT-027）**：v0.7.4 及此前「一键探测全部模型并固化配置」的产物不留存——「固化 N 处」计数恒 0（服务端自动收敛后客户端再 apply 恒 already-verified，一并解决历史登记项 MAINT-019 P2-2）、no-change 收敛的定级不落盘（缺 pin）、探测结果刷新/重启后不回显、不在 llm-pi-ai 配置的模型被静默跳过。现①/probe 响应携带每模型持久化结局分类（not-in-config / converged / no-change / persist-error），固化计数如实；②no-change 收敛补写 pin，探测定级完整落盘；③**探测结果持久回显**——lastProbe 落盘，重启 DSH 后设置页仍显示上次探测结果与结局列；④越界目标透明化——不在 llm-pi-ai 配置的模型明确标注「仅展示，未写入」，不再静默。**升级到 0.7.5 即修复**——受影响者为所有使用一键探测的用户，无需配置迁移或任何用户操作。
- **全局等级未随模型切换生效修复（MAINT-028）**：v0.7.4 及此前插件无路由默认所有权台账——重启 DSH 后无法认领自己写入的路由默认，切换模型时宿主将其物化为会话显式选择，全局等级变更被卡死不跟随（原报障根因）；状态行按存在性计数掩盖真实值差异。现①**所有权台账持久化**（`llm-reasoning.applied` 落盘、boot 恢复）——重启后插件正确认领并跟随全局等级变更；禁用插件后可正确还原；②状态行值核对——路由当前值≠全局目标时如实警示；③统计页「(默认)」条目新增复合标签（如「(默认→高)」）标注实际物化等级，hint 文案与实现对齐；④README 新增物化语义说明（切换模型时宿主把路由默认物化为会话显式选择；显式选择优先是设计承诺）。**升级到 0.7.5 即修复**——0.7.5 前的历史陈旧路由值见下方升级注记，需一次性手动清理后插件即接管。

### Changed
- 无 breaking changes
- 无依赖更新（dependencies 保持空、peers `*` 不变）；无 Feature Flag 变更
- 版本号 0.7.4 → 0.7.5（PATCH：两项缺陷修复 + 防护测试，无新用户功能面、无 breaking、无依赖变更）

### Notes
- **升级注记（0.7.5 前的历史陈旧路由值）**：所有权台账为本版新增，无法追溯认领 0.7.5 之前宿主已物化的陈旧路由值（如曾手工/历史写入的 `providers.<route>.reasoning: high`）——需一次性手动删除 llm-pi-ai 配置中 `providers.<route>.reasoning` 后重启 DSH，插件即接管（此后全局等级变更永久跟随）；也可经宿主配置文件编辑完成。
- **向后兼容（回退安全）**：`applied`（台账）与 `lastProbe`（探测回显）为本版新增持久字段，回退 0.7.4 时旧版忽略、不冲突。
- 已知遗留：台账持久化在同帧多路径写入下存在理论竞态（审查 P2-1；有自愈路径，计划 0.7.6+ 加固）；审查 P3 备忘 ×8 已入 backlog。
- 根因分析详见 `docs/retro/rca-MAINT-027-028.md`（RCA 报告，随本版入库）。
- 发布范围 = MAINT-027 + MAINT-028（8382ffb / ff67d25 探测留存两批 + e700f8a / 88558de 等级跟随两批 + 298ac9e RCA 报告 + 版本收口）；质量依据：合并代码审查通过（无未解决阻塞项）+ 全量回归 14/14 文件 65 用例 + client-smoke + 用户真实验收通过（2026-09-06）。

---

## 0.7.4 (2026-09-05)

### Fixed
- **设置页写入全灭修复（v0.7.3 P0 回归）**（MAINT-025）：v0.7.3 在 DSH 0.1.2-rc.1 上设置页几乎所有按钮与设置逻辑失效——全局开关、全局等级、同步 agent 开关、模型级默认增改删、辅助调用等级的每一次写入均报「保存失败」且设置值不落盘；页面渲染、模型下拉、实时统计与一键探测不受影响（读路径零参恰好匹配，仅写路径全灭）。根因：客户端 hostApiFace 适配层以 2 个位置参数转发 `remote.settings.update/mutate`，而宿主 0.1.2-rc.1 网关对 typed remote 执行严格元数守卫（要求 3 参 `ns, patch/ops, expectedRevision`），RPC 发起前即确定性拒绝。现适配层补齐第三参（显式 `undefined` = 宿主文档化语义「无条件写入」，为后续乐观并发预留透传，不构成行为变更）。**升级到 0.7.4 即修复**——无需配置迁移或任何用户操作。

### Added
- **真实工件判别测试 + 契约校验桩**（MAINT-025 防护，面向开发者/维护者）：新增判别测试以真实宿主工件（dsh-api-remotes 描述符 + 网关元数守卫语义）驱动真实 `lib/client.js`——适配层与宿主契约断裂在 CI 即红，杜绝「测试桩抄适配层假设自证」的假绿（本次 P0 的逃逸通道）；client-smoke 冒烟桩升级为契约校验桩（元数/形状违约即 fail）并实驱设置写路径。

### Changed
- 无 breaking changes
- 无运行时依赖更新（dependencies 保持空、peers `*` 不变）；devDeps 精确锁版 `@deepseek-ai/dsh-api-remotes@0.1.2-rc.1`（判别测试真实工件来源，CI 环境可解析——非运行时依赖）
- 无 Feature Flag 变更

### Notes
- 已知问题：无（全量 50 用例中 3 例沙箱 spawn EPERM 为本机测试环境限制，非产品缺陷）。
- 根因分析与防护方案详见 `docs/retro/rca-MAINT-025.md`（RCA 报告，随本版入库）。
- 客户端面对宿主的版本要求不变（DSH ≥ 0.1.2-rc.1——v0.7.3 既有要求，非本版新增 breaking）。
- 发布范围 = 仅 MAINT-025（ed3c784 修复与防护 + cdbfee7 RCA 报告 + devDeps 锁版修复）。

---

## 0.7.3 (2026-09-05)

### Added
- **设置页 UI/UX 重构**（UX-001）：现代卡片式 + 明暗自适应——设计令牌集中（色板/间距/圆角/字号阶梯）、5 卡片分区（全局设置/模型级默认/辅助调用等级/实时统计/说明折叠）、等级 chips 徽章、斑马纹表格、统一按钮体系；全部颜色半透明灰阶 + currentColor + 语义色半透明变体（零宿主 CSS 变量依赖）；零新依赖，功能与 wire 面不变。

### Fixed
- **DSH 0.1.2-rc.1 升级兼容（客户端面）**（MAINT-022）：dsh-client-connection 0.1.2-rc.1 移除 connection handle 的 `api` 字段（宿主源码 lib/client.js:4754-4825），客户端 `apply()` 旧实现 `connection.api` 恒 undefined → 设置页「统一推理等级」内容区整页空白（首次数据调用同步抛 TypeError，被宿主 SlotErrorBoundary 捕获渲染空 div；用户 2026-09-05 截图实证，link:/file: 重装无改善）。现改为 `hostApiFace` 适配层——统一消费宿主 typed remote 命名空间（`remote.settings` describe/update/mutate + `remote.session.modelCatalog`），收敛为页面既有旧信封 `{result:{ok,value|error}}`（页面消费点零改动）；模块 `inject` 声明 `['slots','locale','remote','remote.settings','remote.session']`（runner 激活门控等待宿主面就绪，官方先例 dsh-client-ui-settings-models）；旧 connection 路径删除；命名空间缺失 fail-loud（结构化错误进页面，禁裸 TypeError）。同源先例：dsh-agent-router FIX-028（用户复验通过）。
- **DSH 0.1.2-rc.1 升级兼容（宿主面）**（MAINT-021）：dsh-settings 0.1.2-rc.1 从公共导出面移除 `settingsNamespace`（连同 `installSettingsSection` / `deepEqualJson`），宿主行的静态具名 import 在模块加载期即抛 `SyntaxError`——插件行加载失败升级为 profile 挂载失败，**整机 DSH 拉不起**（用户 2026-09-05 实测）。现改为命名空间导入 + 运行时探测的跨版本接缝：优先取包内 `settingsNamespace`（≤0.1.1-rc.2 旧宿主），缺席时回退到语义同源（正则/报错/返回值一致）的本地校验器（≥0.1.2-rc.1 新宿主）——peers `*` 全版本范围可加载。
- 新增回归守护：`test/settings-namespace-compat.test.mjs` 子进程以「无 `settingsNamespace` 导出」的 dsh-settings 存根加载宿主行，断言加载成功（守护不依赖 devDependencies 装的是哪一代，devDep 回退旧版时契约仍被测试）。
- 新增回归守护：`test/client-host-face-compat.test.mjs` 以「新宿主形状」fixture（connection 无 api、remote.settings/remote.session 直面，describe 值按宿主 schema 全量保真——含 applies/secrets/revision）驱动真实 `lib/client.js`——注册/inject 声明/描述全链/模型目录/等级变更（update）/删除模型默认（mutate unset ops）/fail-loud/失败文本可见性八用例（旧代码在此形状下 5 用例红：复现用户空白页根因）。`scripts/client-smoke.mjs` ctx 同步迁移新形状并断言 section 元素携带适配层 api。
- **审查返工（R0-F1/F2/F4/F5）**：数据面失败（describe 信封 ok:false / 适配层 fail-loud）时错误文本进入页面——loading 态渲染 notice + 适配层结构化错误文本透出（原实现 notice 仅在 loaded 视图渲染、`.catch` 丢弃错误文本，失败时页面永远停留在「加载中…」——审查实测证伪后修正，使「错误直入页面」的申报行为成真）；补删除模型默认的 mutate 臂断言（ns + `{op:'unset',path:['models',key]}` 位置参数形状）；更正判别组 RED 计数（4→5，用例 2 注册在旧代码下仍绿）。

### Changed
- devDependencies `@deepseek-ai/dsh-settings` 0.1.1-rc.2 → **0.1.2-rc.1**（精确锁版）：测试套件自此针对新一代宿主包执行（47/47 全绿）；运行时依赖策略不变（dependencies 恒空、peers `*`）。
- 客户端模块 `inject` 声明 `['slots','connection','locale']` → `['slots','locale','remote','remote.settings','remote.session']`：设置页自此要求宿主 ≥ 0.1.2-rc.1（旧宿主上插件客户端保持等待、设置页不出现，其余功能不受影响；宿主行仍跨版本可加载——MAINT-021 接缝）。

### Notes
- 其余 0.1.2-rc.1 宿主接缝核验无漂移：`settings.register/get/update/replace/mutate/describe`、`settings/updated` 事件、`llm.resolveModelInfo`/`llm.stream`/`llm/stream`、`agent/request(-error)`、`webServer.register` 及浏览器侧 `settings.section` 槽位均未变更；cordis 4.0.1→4.0.2、schemastery 3.18.1→3.18.2 lib 字节一致。
- `session.modelCatalog` 的 `groups` 形状与旧 `api.llm.models` 的 `groups` 一致（锚定 dsh-api-remotes result schema），模型级默认下拉数据面无漂移。
- 金丝雀验证（layer 1，2026-09-05）：dsh-base + dsh-web-app + 本插件（file: 快照）组合启动日志零插件告警，`/reasoning-level-stats` 端点 HTTP 200，boot 组合脚本含本插件 client bundle。

---

## 0.7.2 (2026-08-26)

### Added
- **通用思考等级词汇表**（MAINT-017）：探测候选改为 7 档通用词汇表全量——`off / minimal / low / medium / high / xhigh / max`。候选不再受模型目录声明与预设枚举限制，qwen 等模型的非标准档位（如 **xhigh**、max）不再被过滤，可进入实测与固化。

### Fixed
- **探测等级发现修复**（MAINT-017）：v0.7.1 的 discovery 机制在真实环境未生效（dsh-llm 本地校验拦截声明外等级，网关收不到发现请求——用户实测 qwen 仍丢 xhigh）。现改为**临时声明全量词表 → llm.stream 实测 → 固化收敛**：实测可用的等级自动写回该模型能力声明（用户手写声明保留其等级与 wire 值、实测新档位自动并入；本插件生成或未声明的声明按实测集替换）；每次探测全量重测全部候选等级，实测拒绝的等级仅作为该次探测结果展示。
- **黑名单提示文案更新**（MAINT-015）：设置页「一键探测」相关提示不再声称"实测拒绝的等级已入黑名单并持久化（重启后仍生效）"——与黑名单仅该次探测结果、运行时自愈内存态（重启即清零）的实际行为一致。

### Changed
- 无 breaking changes
- 无依赖更新（dependencies 保持空、peers `*` 不变）
- 无 Feature Flag 变更

### Removed
- 无（v0.7.1 的 discovery 内部机制由"词表全量候选 + 实测收敛"替换，属实现替换，非用户可见功能移除）

### Notes
- 上述修复均为默认行为修正，无需配置迁移或用户操作。
- 既有 `probeBlacklist` 设置字段兼容保留，不再生效，可安全清理（`settings.yaml` 中删除该键）。
- 发布范围 = MAINT-017 + MAINT-015（不含 MAINT-018 主动探测演进 / MAINT-019 审查 P2 建议 / MAINT-020 审查 P3 记录项——已入账 0.7.3+）。

---

## 0.7.1 (2026-08-25)

### Added
- **探测等级发现增强**（MAINT-014）：新增必然失败探测（discovery）机制——发送 `__dsh_discovery__` 非法 effort，从网关返回的错误消息中解析模型真实支持的等级列表；发现结果与目录声明、配置声明取并集作为探测候选，不再被预设枚举（`LEVELS.includes`）硬过滤。**qwen 等非标准档模型不再遗漏**（如 xhigh、自定义档位），非标准档以其等级名自身为线值固化。

### Fixed
- **黑名单机制修正**（MAINT-013）：黑名单改为**仅当前会话内存态**——每次探测开始时重置全部黑名单，历史误判不再跨次生效。`probeBlacklist` 字段兼容保留（零数据破坏）但不再写入、不再作为注入跳过依据。运行时自愈降级（真实调用被网关拒绝）保留内存态，不持久化，重启清零。侧面影响：设置页「一键探测」不再被旧黑名单污染，每次全量重测全部候选等级。
- **discovery 独立短超时**（MAINT-016）：`discoverLevelsFromRejection` 使用独立 5s 超时（`DISCOVERY_TIMEOUT_MS=5000`），避免网关对非法 effort 挂起时阻塞整个探测流程 30s。常规探测超时仍为 30s 不变，`probeLevelOnce` 新增可选第 4 参数 `timeoutMs`（向后兼容）。

### Changed
- 无 breaking changes
- 无依赖更新（dependencies 保持空、peers `*` 不变）
- 无 Feature Flag 变更

### Removed
- 无

### Notes
- 上述修复均为默认行为修正，无需配置迁移或用户操作。
- 既有 `probeBlacklist` 设置字段兼容保留，不再生效，可安全清理（`settings.yaml` 中删除该键）。
- 发布范围 = MAINT-013 + MAINT-014 + MAINT-016（不含 MAINT-015 client.js 文案——留后续版本）。

---

## 0.7.0 (2026-08-23)

### Added
- 统计面板「一键探测全部模型并固化配置」——逐模型 1-token 实测全部候选等级（单次 30s、单模型并发 3）
- 可用等级写回模型能力声明并持久化 `probeEfforts`（重启后不被生成表覆盖/升级）
- 能力声明持久化——`llm-reasoning.probeEfforts` 落盘 settings.yaml，实测结果即真值
- `purpose` 级默认——`purposes.compaction` / `purposes.session-title` 独立等级
- 实测按钮——统计面板发 1-token 请求验证某模型某等级实际可用

### Fixed
- 修复 v0.4 以来探测「全部显示失败」根因——探测请求消息体改 ContentBlock 数组（旧字符串 content 触发 `content.some is not a function`）
- 探测带 `probe` 标记旁路统计与注入，观测零污染
- 统计面板回环边界加固——Host 头字符集预检，阻断多种绕过形态
- 修复 IPv6 回环（`::1` 含括号/裸）识别
- 设置页统计面板 `t is not defined` 渲染崩溃（client-smoke 冒烟门禁拦截）

### Security
- 统计端点回环边界加固（Host 头解析前字符集预检）
- statsPublic 安全警示补充（连带开放探测端点）

### Changed
- 无 breaking changes
- `dependencies` 清零，宿主包全 `peer`（`*`）对齐 DSH out-of-tree 官方契约
- 安装全面改走 `dsh plugin` 通道（不再 junction 共享树/手改 patch/写 settings）

### Quality
- 29 用例回归防护网接入 CI（`node --test`）
- 依赖策略 CI 门禁（dependencies 空、peers 非空、`@deepseek-ai/*` 不得出现在 dependencies）
- 渲染冒烟测试（`client-smoke.mjs`）
