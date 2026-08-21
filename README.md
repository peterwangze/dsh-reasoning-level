# dsh-reasoning-level

> DeepSeek Harness（DSH）统一推理等级插件：**一个设置项，动态管理所有模型的默认思考强度**——含模型级默认与实时调用观测。

[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://github.com/peterwangze) [![version](https://img.shields.io/badge/version-0.2.4-green)](./package.json) [![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#一键安装)

---

## 项目目标

DSH 接入的多服务商模型（DeepSeek 官方、智谱、聚合网关、自建中转……）对"思考强度 / 推理等级（reasoning effort）"的支持千差万别：有的模型选不了等级、有的只到 `high`、有的支持 `max`；手写声明的模型甚至不出现等级选项。逐模型手改 `settings.yaml` 既繁琐又容易把不支持的等级写进配置导致请求报错。

本插件把这件事收敛为**一处配置、动态生效、可观测**：

- **统一默认**：全局一个默认等级，自动落到每条路由/每个模型（只在全部支持时写入，杜绝 `UNSUPPORTED_REASONING_EFFORT`）；
- **能力补齐**：手写声明、没有推理能力元数据的模型自动获得等级声明（含实测可用的 `max`），模型选择器立刻出现可选等级；
- **模型级覆盖**：`provider/model` 粒度的独立默认，界面按**各模型实测支持等级**过滤选项；
- **实时观测**：每次模型调用的实际等级、思考/输出 tokens、结束原因实时可见——设置不是空壳，效果全程可追溯；
- **保守可靠**：显式选择永远优先；关闭开关即完整还原；用户手改的配置永不被覆盖。

等级优先级：**会话/模型选择器显式选择 > 模型级默认 > 全局默认 > 服务商自身默认**。

## 功能特性

- 手写模型自动补齐「推理等级」能力（含最大 Max——智谱 bigmodel 等网关实测接受 `reasoning_effort: max`）
- 路由级默认等级（该路由全部模型支持时才写入）
- DeepSeek 官方路由同步（`llm-deepseek.reasoningEffort`，取 off/low/high/max）
- 模型级默认：`models: {"provider/model": level}`，界面按模型实测能力过滤可选项、探测结果标注、独立删除按钮
- **全路径注入**（v0.3.0）：模型级默认不只对 agent-loop 会话生效——router 子代理 / session-title / compaction 等手建调用同样注入（`llm/stream` 未冻结请求注入）
- **自愈降级**（v0.3.0）：网关实测拒绝某等级（`UNSUPPORTED_REASONING_EFFORT`）自动记入黑名单，后续注入跳过，设置页明示
- **统计增强**（v0.3.0）：每次调用耗时、流内思考字符近似（网关不回报 reasoning_tokens 时仍可观测思考量）、来源（sessionId/purpose）
- **同步默认 agent 模型**（v0.3.0）：`syncDefaultAgent` 开启时全局等级变化同步写 `agent-default-model.reasoningEffort`
- **统计持久化**（v0.3.0）：聚合数据落盘 `$DSH_HOME/storages/reasoning-level-stats.json`，重启后恢复
- 实时调用统计：环形缓冲 300 条 + 按模型聚合（等级分布 / 思考 tokens / 错误数），设置页 2s 刷新
- 改设置即生效：适配器每次请求重读设置，无需重启
- 兼容官方安装通道：`dsh plugin add / update / remove`（`dsh.bundle.patch` bundle 层声明）

## 一键安装

### 方式一（推荐）：`dsh plugin` 标准命令

```sh
dsh plugin --profile web add peterwangze/dsh-reasoning-level     # 从 GitHub 安装（git spec）
dsh plugin --profile web update dsh-reasoning-level              # 升级
dsh plugin --profile web remove dsh-reasoning-level              # 卸载
```

也支持 npm 包名或本地路径：`dsh plugin --profile web add dsh-reasoning-level`、`add file:/path/to/pkg`。

安装后自动挂载为 profile 的 bundle 层（`dsh.profile.bundles`），**重启 DSH 生效**，无需手改任何配置文件。

本地开发（改代码即生效，无需重装）：

```sh
dsh plugin --profile web add link:/path/to/dsh-reasoning-level
```

> `file:` 规格是 pnpm 的内容寻址快照，源码更新后需 `remove` 再 `add` 刷新；`link:` 是符号链接直连源码，无此问题。

### 方式二：离线一键脚本（无 pnpm / 内网环境备选）

**Windows（PowerShell 5.1+）**——在线一行：

```powershell
powershell -ExecutionPolicy Bypass -Command "iex (((irm https://raw.githubusercontent.com/peterwangze/dsh-reasoning-level/main/install.ps1) -join [Environment]::NewLine).TrimStart([char]0xFEFF))"
```

离线（解压发行包后在包目录内）：`.\install.ps1 -LocalPath .`

**macOS / Linux / Git Bash**——在线一行：

```sh
curl -fsSL https://raw.githubusercontent.com/peterwangze/dsh-reasoning-level/main/install.sh | sh
```

离线：`./install.sh --local .`

脚本幂等可重复执行：接入 `profiles/node_modules`（junction/符号链接优先，失败回退拷贝）→ 在 profile `cordis.patch.yml` 插入组合行 → `settings.yaml` 无 `llm-reasoning` 节时写入默认配置。参数：`-Profile/--profile`（默认 `web`）、`-RepoUrl/--repo`、`-Ref/--ref`、`DSH_HOME` 环境变量。

## 使用指导

### 1. 打开设置页

重启 DSH 后：**设置 → 统一推理等级**。页面分四块：

| 区块 | 作用 |
|---|---|
| 全局开关 + 默认等级 | 总开关（`enabled`）与全局默认等级（`level`） |
| 模型级默认 | 按 `provider/model` 覆盖全局默认；下拉只列**该模型实测支持**的等级，模型名旁标注支持列表，每行有删除按钮 |
| 实时调用统计 | 每次调用的实际等级/思考 tokens/输出/结束原因 + 按模型聚合（等级分布） |
| 状态行 | 已应用路由/模型数、DeepSeek 官方默认 |

### 2. 推荐上手路径

1. 安装并重启后保持默认（`high`）——所有支持等级的模型立即获得默认；
2. 在**模型选择器**里抽查：任意模型应显示 `模型名 · 高`（之前无等级选项的模型也会出现）；
3. 想让某个模型深度思考：模型级默认里添加该模型 → 选它支持的最高档（如智谱 GLM-5.3 的 `max`）；
4. 打开统计面板发一条消息——2 秒内出现新记录，`推理等级` 列即该次请求实际使用的等级。

### 3. 等级档位

| 等级 | 含义 |
|---|---|
| `off` | 不发送推理参数（与不设置等价） |
| `minimal` / `low` / `medium` / `high` | `reasoning_effort` 标准档 |
| `xhigh` | 无标准线值：不向手写模型声明（目录模型按其目录能力） |
| `max` | 原样发送 `reasoning_effort: max`（智谱等实测支持；不支持的模型自动跳过） |

### 4. 配置参考（`$DSH_HOME/settings.yaml`，一般无需手改）

```yaml
llm-reasoning:
  enabled: true   # false = 撤销本插件写入的全部默认（能力声明与路由默认一并还原）
  level: high     # 全局默认
  models:         # 模型级默认（键 "provider/model"）
    "zai-coding-cn/GLM-5.3": max
```

插件运行时自动维护：`llm-pi-ai.providers.<route>.models[].reasoningEfforts`（能力声明，含旧版自动升级）、`llm-pi-ai.providers.<route>.reasoning`（路由默认）、`llm-deepseek.reasoningEffort`。

### 5. 验证生效（观测方法）

- **请求层（最硬）**：会话日志归档每次请求的最终配置——
  `zstd -dc ~/.dsh/sessions/<会话目录>/session.jsonl.zstd | grep '"type":"request/header"'`，其中 `reasoningEffort` 即实际携带等级；
- **效果层**：同日志 `usage.reasoningTokens` 为真实思考 token 数（模型回报时）；
- **实时**：设置页统计面板，或直接 `curl http://127.0.0.1:3080/reasoning-level-stats`；
- **A/B**：切 `off` ↔ `max` 问同一问题，对比思考时长与 reasoningTokens。

## 卸载

```sh
dsh plugin --profile web remove dsh-reasoning-level    # 方式一
```

或离线脚本安装的：删除 profile `cordis.patch.yml` 中的 `reasoning-level` 行 + 删除 `profiles/node_modules/dsh-reasoning-level`。

可选清理：把 `llm-reasoning.enabled` 改为 `false` 重启一次（还原插件写入的字段），然后删除 `settings.yaml` 的 `llm-reasoning` 节。

## 工作原理（简）

- **宿主行**（`- id: reasoning-level`，dual-face）：注册 `llm-reasoning` settings 命名空间；监听 `settings/updated` 把目标配置**收敛**进 `llm-pi-ai` / `llm-deepseek`（`settings.replace` 整节写，避开 mutate 的数组路径限制）；
- **模型级默认**：`agent/request` 提案 waterfall 注入（仅当提案无显式等级且该模型实测支持）；
- **统计**：`llm/stream` waterfall 只读旁路（采集 usage/finish chunk）；`webServer` 暴露 `/reasoning-level-stats` 供设置页轮询；
- **设置页**：`settings.section` 槽位；读写走标准 wire 面（`api.settings.describe/update/mutate`、`api.llm.models` 能力探测）。

依赖：宿主 base 组合的 `settings` / `llm` / `llm-pi-ai` / `llm-deepseek`（后两者缺席时自动跳过对应部分）；浏览器侧为 web profile 默认组合。

## License

MIT
