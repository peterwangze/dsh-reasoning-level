# 回滚方案 — dsh-reasoning-level v0.7.2

> 本方案参考 v0.7.1 REL-002 回滚方案（主路径 canary 实战验证），适用于 v0.7.1→0.7.2 升级后的回滚场景。
> v0.7.2 变更面：通用 7 档词汇表（`off/minimal/low/medium/high/xhigh/max`，新增 xhigh 档）+ 临时声明→实测→固化收敛 + client.js 黑名单文案更新（MAINT-017 + MAINT-015）。**无数据迁移、无 breaking、无字段删除/重命名**——全部 additive 与行为修正。

## 1. 回滚前置条件

- 回滚前**确认未发布 tag 通知**（如已推送 tag 需执行 §3 tag 回滚步骤）
- 回滚期间 DSH 服务需重启一次（remove 后重启生效）
- 回滚不影响用户数据（插件配置在 settings.yaml，remove 后惰性残留，见 §4）
- 回滚含义确认：主路径 = remove 插件（v0.7.2 → 无插件，回到 v0.7.1 之前状态）；若为"退版本回 v0.7.1"，先撤销发布（tag 未通知时 §3，已通知/已发布则建议发布 0.7.3 修复而非回滚已公开版本）

## 2. 回滚主路径：`dsh plugin remove`

```powershell
# 1) 移除插件（先执行——remove 足够快，无需备份 profile 组合文件）
dsh plugin --profile web remove dsh-reasoning-level

# 2) 重启 DSH
#    移除后 profile 不再加载该插件 bundle，重启后插件级功能（等级统一/注入/统计/探测）消失

# 3) 验证（金丝雀冒烟）
#    a. 发一条消息 → 模型正常回复（请求路径未被破坏）
#    b. 设置页 → 统一推理等级页 404 或消失（正常——插件卸载）
#    c. `dsh plugin list` → 确认 dsh-reasoning-level 不在列表中
```

**预计回滚时间**：~3 分钟（remove 命令 <30s + DSH 重启 <2min + 验证 <1min）

**回滚验证标准**：
- 消息发送正常（请求路径零影响）
- 设置页无插件相关错误
- DSH 启动日志零插件加载告警

## 3. Tag 回滚（仅在 tag 已推送且未通知时使用）

```powershell
# 1) 删除远程 tag（先删除——避免他人拉取到该版本）
git push origin :refs/tags/v0.7.2

# 2) 删除本地 tag
git tag -d v0.7.2

# 3) 确认
git tag -l "v0.7*"
# 输出应仅显示 v0.7.0、v0.7.1
```

**注意**：如果 v0.7.2 已通过 GitHub Release 发布（非仅 tag），请先 `gh release delete v0.7.2` 再删除 tag。如果社区已有用户拉取到该版本，建议发布 v0.7.3 修复而非回滚已公开版本。0.7.1 先例：tag/Release 撤回路径相同（REL-002）。

## 4. 数据兼容说明

### 4.1 向前兼容（v0.7.1 → 0.7.2 升级，无需迁移）

| 数据 | 兼容性 | 说明 |
|------|--------|------|
| `llm-reasoning.probeBlacklist` | 🔄 兼容保留 | v0.7.1 起不再写入/读取，既有数据安全忽略（MAINT-013 语义延续） |
| `llm-reasoning.probeEfforts` | ✅ 兼容扩展 | 新增词汇表全量键（含 xhigh、max），既有标准档键不变 |
| `llm-reasoning.level` / `models` 值域 | ✅ 兼容扩展 | 新增 xhigh 档（1 档 additive；`LEVELS` 兼容别名指向 7 档词表，lib/index.js:75-77），既有 6 档值全部保持 |
| `llm-pi-ai.providers.*.models[].reasoningEfforts` | 🔄 运行时写入 | v0.7.2 探测期间写临时声明（全词表）、探测后收敛固化；失败路径已回滚（F1 收敛失败回滚 + applyPiAi 守卫），异常中断残留见 §4.2 |
| 运行时黑名单 | ❗ 会话内存态 | 探测拒绝仅该次展示；真实调用失败临时跳过，重启清零（MAINT-013 语义） |

### 4.2 向后兼容（v0.7.2 → 0.7.1 回滚，数据安全）

| 数据 | 兼容性 | 说明 |
|------|--------|------|
| `llm-reasoning.probeEfforts` | 🔄 惰性残留 | v0.7.2 写入的键 v0.7.1 插件仍可读（schema 兼容），但不会更新/收敛；如需完全回退，可删除 settings.yaml 中 `llm-reasoning.probeEfforts` 节 |
| `llm-reasoning.level` / `models` 含 xhigh 值 | ⚠️ 0.7.1 未声明 xhigh 档 | 0.7.1 的等级 schema 为 6 档（off/minimal/low/medium/high/max），**xhigh 为 0.7.2 新增**。回滚后含 xhigh 的值不在 0.7.1 已知档位内（具体表现为按 0.7.1 逻辑处理/忽略/校验报错——以 0.7.1 实际行为为准）：如有异常，把相关值改为 6 档内等级或执行 §4.3 清理后重启 |
| `llm-pi-ai.providers.*.models[].reasoningEfforts` | 🔄 惰性残留 | v0.7.2 收敛固化/临时声明写入的条目不因回滚自动清除；卸载后重启自动失效（设置页重新生成表）。异常中断残留（全词表临时声明）→ 手动删除该模型 `reasoningEfforts` 键让 llm-pi-ai 重新生成，或按 §4.3 清理 |
| `probeBlacklist` | ✅ 无残留 | v0.7.2 不写入此键；如 v0.7.0/v0.7.1 已有则保留 |
| 代码注释中的 MAINT-017/015 引用 | ✅ 零影响 | 注释不参与运行时行为 |
| 回滚后用户感知 | ⚠️ 已知问题回归 | 回到 v0.7.1 行为 = 已知三项未达预期回归（黑名单旧文案/qwen 丢 xhigh/发现机制无效）——回滚即放弃 0.7.2 修复，属预期取舍 |

### 4.3 彻底清理（可选——回滚后如需完全卸载残留）

```yaml
# settings.yaml 中删除以下键即可彻底清理所有 v0.7.2 相关遗留
llm-reasoning:
  # probeEfforts: {}     # ← 删除（如有，含 xhigh 键条目）
  # probeBlacklist: {}   # ← 删除（如有，v0.7.2 不写入但旧版本可能有）
  # level: xhigh         # ← 如回滚后值异常，改为 6 档内等级或删除
  # models: { "provider/model": xhigh }  # ← 同上
```

或设置 `llm-reasoning.enabled: false` 重启一次（还原插件写入的所有字段），然后删除整个 `llm-reasoning:` 节。`llm-pi-ai` 侧残留：删除对应模型条目的 `reasoningEfforts` 键（或整节 `providers` 中手工/本插件写入部分），重启后由 llm-pi-ai 自动重新生成。

## 5. 回滚失败场景与应急

| 场景 | 处理方式 | 预计耗时 |
|------|---------|---------|
| `dsh plugin remove` 失败 | 手动删除 profile 的 `node_modules/dsh-reasoning-level` 目录 + 从 `cordis.patch.yml` 移除该 bundle 行 | ~5min |
| 组合文件异常 | 按 v0.7.0 REL-001 层 2 快照恢复：`Copy-Item "$env:TEMP\web.package.json.bak" "$env:USERPROFILE\.dsh\profiles\web\package.json"`（如回滚前有备份） | ~1min |
| 设置页 schema 报错（含 xhigh 值） | 执行 §4.3：把 `llm-reasoning.level`/`models` 中 xhigh 值清回 6 档内，重启 | ~2min |
| 启动失败 | 检查日志定位具体错误；如为其他插件冲突，依次移除后单独验证 | ~10min |

## 6. 降级限制（已知）

- **不验证降级 v0.7.1**：主回滚路径 = remove（v0.7.2 → 无插件），不验证保留插件回退旧版本（REL-002 先例：v0.7.1→0.7.0 亦不验证语义降级）。如需语义降级（保留插件但回退行为），设置 `llm-reasoning.enabled: false` 并重启即可还原插件写入的所有配置字段；但 0.7.2 新增词汇表（xhigh 档）语义不在 enabled:false 范围内独立体现（0.7.2 为默认行为修正，无独立开关）。
- v0.7.2 未引入 schema/数据迁移，回滚零数据迁移负担（§4.2）。

## 7. 回滚时间预算

| 步骤 | 乐观 | 典型 | 最坏 |
|------|:----:|:----:|:----:|
| `dsh plugin remove` | 10s | 30s | 2min |
| DSH 重启 | 30s | 1min | 3min |
| 冒烟验证（消息发送） | 30s | 1min | 3min |
| xhigh 清理（如触发 §4.3） | 30s | 1min | 3min |
| **合计** | **~1min** | **~3min** | **~11min** |

---

*回滚方案版本：v0.7.2 | 编制：Release Agent REL-003 | 日期：2026-08-26 | 参考：v0.7.1 REL-002 / v0.7.0 REL-001 R0 回滚方案*
