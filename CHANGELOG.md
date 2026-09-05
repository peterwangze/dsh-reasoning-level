# Changelog

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
