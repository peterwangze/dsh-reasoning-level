# Changelog

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
