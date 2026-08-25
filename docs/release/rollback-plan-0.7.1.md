# 回滚方案 — dsh-reasoning-level v0.7.1

> 本方案参考 v0.7.0 REL-001 R0 回滚方案（canary 实战验证），适用于 v0.7.0→0.7.1 升级后的回滚场景。

## 1. 回滚前置条件

- 回滚前**确认未发布 tag 通知**（如已推送 tag 需 tag 回滚步骤）
- 回滚期间 DSH 服务需重启一次（remove 后重启生效）
- 回滚不影响用户数据（插件配置在 settings.yaml，remove 后惰性残留）

## 2. 回滚主路径：`dsh plugin remove`

```powershell
# 1) 移除插件（先执行——remove 足够快，无需备份 profile 组合文件）
dsh plugin --profile web remove dsh-reasoning-level

# 2) 重启 DSH
#    移除后 profile 不再加载该插件 bundle，重启后插件级功能（等级统一/注入/统计）消失

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
git push origin :refs/tags/v0.7.1

# 2) 删除本地 tag
git tag -d v0.7.1

# 3) 确认
git tag -l "v0.7*"
# 输出应仅显示 v0.7.0
```

**注意**：如果 v0.7.1 已通过 GitHub Release 发布（非仅 tag），请先 `gh release delete v0.7.1` 再删除 tag。如果社区已有用户拉取到该版本，建议发布 v0.7.2 修复而非回滚已公开版本。

## 4. 数据兼容说明

### 4.1 向前兼容（v0.7.0 → 0.7.1 升级，无需迁移）

| 数据 | 兼容性 | 说明 |
|------|--------|------|
| `llm-reasoning.probeBlacklist` | 🔄 兼容保留 | v0.7.1 不再写入/读取，既有数据安全忽略（MAINT-013 设计约束） |
| `llm-reasoning.probeEfforts` | ✅ 兼容扩展 | 新增 discovery 等级（非标准档），既有标准档键不变 |
| `llm-reasoning.enabled` / `level` / `models` | 🔄 零影响 | 未变更 |
| 运行时黑名单 | ❗ 会话内存态 | v0.7.1 重启后清空（v0.7.0 持久化黑名单不再装载） |

### 4.2 向后兼容（v0.7.1 → 0.7.0 回滚，数据安全）

| 数据 | 兼容性 | 说明 |
|------|--------|------|
| `llm-reasoning.probeEfforts` | 🔄 惰性残留 | v0.7.1 写入的探测结果键 v0.7.0 插件仍然可读（schema 兼容），但不会更新。如需完全回退，可删除 settings.yaml 中 `llm-reasoning.probeEfforts` 节 |
| `llm-reasoning.probeBlacklist` | ✅ 无残留 | v0.7.1 不再写入此键；如 v0.7.0 已有则保留 |
| `llm-pi-ai.providers.*.models[].reasoningEfforts` | 🔄 惰性残留 | v0.7.1 探测固化写入的能力声明不会因回滚自动清除；卸载后重启自动失效（设置页重新生成表） |
| 代码注释中的 MAINT-013/014/016 引用 | ✅ 零影响 | 注释不参与运行时行为 |

### 4.3 彻底清理（可选——回滚后如需完全卸载残留）

```yaml
# settings.yaml 中删除以下键即可彻底清理所有 v0.7.1 相关遗留
llm-reasoning:
  # probeEfforts: {}     # ← 删除（如有）
  # probeBlacklist: {}   # ← 删除（如有，v0.7.1 不写入但 v0.7.0 可能有）
```

或设置 `llm-reasoning.enabled: false` 重启一次（还原插件写入的所有字段），然后删除整个 `llm-reasoning:` 节。

## 5. 回滚失败场景与应急

| 场景 | 处理方式 | 预计耗时 |
|------|---------|---------|
| `dsh plugin remove` 失败 | 手动删除 profile 的 `node_modules/dsh-reasoning-level` 目录 + 从 `cordis.patch.yml` 移除该 bundle 行 | ~5min |
| 组合文件异常 | 按 v0.7.0 REL-001 层 2 快照恢复：`Copy-Item "$env:TEMP\web.package.json.bak" "$env:USERPROFILE\.dsh\profiles\web\package.json"`（如回滚前有备份） | ~1min |
| 启动失败 | 检查日志定位具体错误；如为其他插件冲突，依次移除后单独验证 | ~10min |

## 6. 降级限制（已知）

- **不验证降级 v0.6.0**：主回滚路径 = remove（v0.7.1 → 无插件），不验证降级到旧版本。如需语义降级（保留插件但回退行为），设置 `llm-reasoning.enabled: false` 并重启即可还原插件写入的所有配置字段。

## 7. 回滚时间预算

| 步骤 | 乐观 | 典型 | 最坏 |
|------|:----:|:----:|:----:|
| `dsh plugin remove` | 10s | 30s | 2min |
| DSH 重启 | 30s | 1min | 3min |
| 冒烟验证（消息发送） | 30s | 1min | 3min |
| **合计** | **~1min** | **~3min** | **~8min** |

---

*回滚方案版本：v0.7.1 | 编制：Release Agent REL-002 | 日期：2026-08-25 | 参考：v0.7.0 REL-001 R0 回滚方案*
