# Changelog

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
