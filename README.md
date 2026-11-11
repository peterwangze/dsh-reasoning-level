# dsh-reasoning-level

> DeepSeek Harness（DSH）统一模型管理插件：**一个设置页管理所有模型的思考强度、多模态能力与采样参数**——含全局默认、预设、模型级覆盖与实时调用观测。

[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://github.com/peterwangze) [![version](https://img.shields.io/badge/version-0.10.0-green)](./package.json) [![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#一键安装)

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

- **统一模型管理工作台**（v0.10.0）：设置页四视图（模型 / 默认与预设 / 观测 / 诊断），按模型提供商分组、搜索、筛选、行内摘要 + 展开详情
- **多模态能力配置**（v0.10.0）：按模型开关图像输入，写回 pi-ai `models[].input` / `modelOverrides[].input` 与 DeepSeek `models[].inputModalities`；带 previous 台账，撤销只恢复插件写入值，用户手改不覆盖
- **采样参数**（v0.10.0）：temperature / maxTokens 真实注入（只填调用方未给出的值）；topP / topK 可保存并标注「预留」——DSH 0.2.2 的 `GenerateOptions` / `LlmCallControls` 无对应字段，宿主支持后经 `lib/param-registry.js` 扩展点启用
- **采样预设**（v0.10.0）：精确 / 均衡 / 创意 / 自定义，作用于全局默认参数
- 手写模型自动补齐「推理等级」能力（含最大 Max——智谱 bigmodel 等网关实测接受 `reasoning_effort: max`）
- 路由级默认等级（该路由全部模型支持时才写入）
- DeepSeek 官方路由同步（`llm-deepseek.reasoningEffort`，取 off/low/high/max）
- 模型级默认：`models: {"provider/model": level}`，界面按模型实测能力过滤可选项、探测结果标注、独立删除按钮
- **全路径注入**（v0.3.0）：模型级默认不只对 agent-loop 会话生效——router 子代理 / session-title / compaction 等手建调用同样注入（`llm/stream` 未冻结请求注入）
- **自愈降级**（v0.3.0）：网关实测拒绝某等级（`UNSUPPORTED_REASONING_EFFORT`）自动记入黑名单，后续注入跳过，设置页明示（仅当前会话内存态，重启清零，不写入 settings.yaml）
- **统计增强**（v0.3.0）：每次调用耗时、流内思考字符近似（网关不回报 reasoning_tokens 时仍可观测思考量）、来源（sessionId/purpose）
- **同步默认 agent 模型**（v0.3.0）：`syncDefaultAgent` 开启时全局等级变化同步写 `agent-default-model.reasoningEffort`
- **统计持久化**（v0.3.0）：聚合数据落盘 `$DSH_HOME/storages/reasoning-level-stats.json`，重启后恢复
- **端点访问控制**（v0.4.0）：统计端点默认仅回环 Host 可读；LAN 部署需显式 `statsPublic: true`
- **off 线值按协议细化**（v0.4.0）：zai/deepseek thinking 格式下 off 显式发送 `disabled`（默认开启思考的模型真正关闭），openai 系缺省
- **purpose 级默认**（v0.4.0）：`purposes.compaction` / `purposes.session-title` 独立等级（辅助调用可用 off 省 token）
- **实测按钮**（v0.4.0）：统计面板发 1-token 请求验证某模型某等级实际可用；网关拒绝仅作为该次探测的拒绝结果返回，不入黑名单（探测是"测量"不是调用）
- **一键探测并固化配置**（v0.7.0）：统计面板**一个按钮**探测全部模型的全部候选等级——实测可用的等级自动写回模型能力声明并持久化；实测拒绝的等级仅作为该次探测结果的拒绝列表返回（不入黑名单、不跨次生效）；每次探测全量重测全部候选等级，历史误判不会卡死后续探测；限流/超时等错误与"等级不可用"严格区分，不再误判
- **探测可用性修复**（v0.7.0）：修复 v0.4 以来探测"全部显示失败"的根因——测试请求的 `Message.content` 必须是 ContentBlock 数组，旧代码传字符串导致适配器在组装阶段就报 `content.some is not a function`（与模型是否支持等级无关）；探测请求标记旁路统计（不污染观测数据），单次 30s 超时、单模型并发 3，探测中的请求全部带 `probe` 标记免污染；（v0.7.2 起同模型并发 /probe 走互斥队列串行化——重复点击/双窗口不互相覆盖临时声明与收敛结果）
- **能力声明持久化**（v0.7.0）：`llm-reasoning.probeEfforts`（实测能力声明）落盘 settings.yaml，重启后不再被生成表覆盖/升级，实测结果即真值；用户手写的模型声明不会被探测覆盖（v0.7.2 起并入语义：保留手写档位与 wire，实测可用的新档位自动追加；本插件生成或未声明的声明按实测 working 集替换，取代早期"永不覆盖"表述）。（v0.7.1 起黑名单改为仅当前会话内存态：`probeBlacklist` 字段兼容保留，不再写入也不再作为过滤依据——每次探测全量重测，历史误判不跨次生效，既有数据零破坏）
- **CSV 导出 + 建议列**（v0.4.0）：统计一键导出 CSV；聚合表显示错误率/实测拒绝建议
- **i18n 基础**（v0.5.0）：client 接入 locale（zh/en 标题与区块）
- **事故加固**（v0.6.0，[VERIFICATION.md](./VERIFICATION.md)）：`dependencies` 清零、宿主包全 peer（`*`）对齐 DSH out-of-tree 官方契约；安装全面改走 `dsh plugin` 通道（不再 junction 共享树/手改 patch/写 settings）；全部注册与钩子失败就地降级，绝不允许升级为 DSH 启动失败；修复设置页统计面板 `t is not defined` 渲染崩溃；新增渲染冒烟测试与依赖策略 CI 门禁
- 实时调用统计：环形缓冲 300 条 + 按模型聚合（等级分布 / 思考 tokens / 错误数），设置页 2s 刷新
- 改设置即生效：适配器每次请求重读设置，无需重启
- 兼容官方安装通道：`dsh plugin add / update / remove`（`dsh.bundle.patch` bundle 层声明）

## 一键安装

> **宿主版本要求（v0.8.0 起，BREAKING）**：本插件 v0.8.0 适配 DSH 设置系统的
> **0.2.0 架构**（插件设置声明改为宿主 Config volatile 投影模型），要求宿主
> **DSH ≥ 0.2.0-rc.2**。旧宿主（0.1.x）上插件**安全自禁用**——数据面不生效、
> 日志给出明确指引，绝不阻塞 DSH 启动或运行。**从 v0.7.x 升级请先
> `dsh plugin remove dsh-reasoning-level` 再安装本版**（entry id 与设置存储
> 模型已变更，先卸载避免新旧 entry 并存）；安装后旧配置（含一键探测固化
> 产物）会从 `settings.yaml.imported` **一次性自动迁移**，无需手动操作。
> 兼容性诊断：`DSH_HOST_TREE=<宿主 node_modules 路径> npm run host:doctor`。

### 方式一（推荐）：`dsh plugin` 标准命令

```sh
dsh plugin --profile web add peterwangze/dsh-reasoning-level     # 从 GitHub 安装（git spec）
dsh plugin --profile web update dsh-reasoning-level              # 升级
dsh plugin --profile web remove dsh-reasoning-level              # 卸载
```

也支持 npm 包名或本地路径：`dsh plugin --profile web add dsh-reasoning-level`、`add file:/path/to/pkg`。

安装后自动挂载为 profile 的 bundle 层（`dsh.profile.bundles`），**重启 DSH 生效**，无需手改任何配置文件。

本地开发也用 `file:` 快照（源码改动后 `remove` 再 `add` 刷新即可）：

```sh
dsh plugin --profile web add file:/path/to/dsh-reasoning-level
dsh plugin --profile web remove dsh-reasoning-level                # 改代码后：先移除
dsh plugin --profile web add file:/path/to/dsh-reasoning-level     # 再重新装（刷新快照）
```

> ⚠️ **普通安装一律用 `file:`，不要照抄 `link:`**：`link:` 是符号链接直连源码
> （改代码免重装），但 `link:` 下 Node 从**源码真实路径**向上解析依赖，永远够不到
> `$DSH_HOME/profiles/node_modules` 平坦回退树；插件的宿主包 peers
> （`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 等）只由该回退树供给。
> 源码目录一旦缺 `node_modules`，插件加载即 `ERR_MODULE_NOT_FOUND`，**整机启动失败**
> （金丝雀实测，见 [VERIFICATION.md](./VERIFICATION.md) 第 3 节）。`link:` 仅供
> **源码目录自带完整 node_modules** 的开发迭代；`install.ps1 -Link` /
> `install.sh --link` 已内置前置自检（缺失即拒绝），请放心使用。

### 方式二：离线一键脚本（解压发行包后使用）

**Windows（PowerShell 5.1+）**：

```powershell
.\install.ps1              # 安装本目录（file: 快照）
.\install.ps1 -Link        # 开发模式（link: 直连源码，改代码重启即生效；脚本前置自检 node_modules，缺失即拒绝）
.\install.ps1 -Uninstall   # 卸载
```

**macOS / Linux / Git Bash**：

```sh
./install.sh               # 安装本目录
./install.sh --link        # 开发模式（link: 直连源码，改代码重启即生效；脚本前置自检 node_modules，缺失即拒绝）
./install.sh --uninstall   # 卸载
```

脚本做三件事：①安全清除旧版（v0.2–v0.5）junction 残留（只删链接本体，绝不递归删真实目录）；②安装前自检依赖策略（`dependencies` 必须为空）；③调用官方 `dsh plugin --profile <P> add <本目录>` 通道完成安装。参数：`-Profile/--profile`（默认 `web`）、`DSH_HOME` 环境变量。

> v0.6.0 起**不再支持**也**绝不应该**用任何手段把插件直接链接进
> `profiles/node_modules` 或手改 `cordis.patch.yml`——旧脚本的 junction 方案
> 曾造成 DSH 无法启动与消息发送失败级事故，详见 [VERIFICATION.md](./VERIFICATION.md)。

### 安装后验证（强烈建议）

按 [VERIFICATION.md](./VERIFICATION.md) 第 3 节执行：层 0 静态门禁（CI 已含）→
层 1 金丝雀 profile 四步冒烟（发消息 / 设置页 / 统计端点 / 等级切换）→
层 2 工作 profile 上线与回滚。**升级 DSH 后第一步先跑 `npm run host:doctor`
兼容面诊断（源码仓库内），再跑金丝雀，最后重启工作 profile。**

## 使用指导

### 1. 打开设置页

重启 DSH 后：**设置 → 统一模型管理**。页面分四个视图：

| 视图 | 作用 |
|---|---|
| 模型 | 按**模型提供商**分组列出全部模型。每行一个「配置来源」开关（跟随全局 ↔ 自定义）+ 只读摘要；点击行展开详情，按维度设置**思考强度**、**多模态**、**采样参数**。支持搜索、提供商筛选、仅显示自定义 |
| 默认与预设 | 全局默认思考强度（分段控件 + 影响预览）、采样预设（精确 / 均衡 / 创意 / 自定义）、全局默认采样参数、辅助调用等级（会话压缩 / 会话标题） |
| 观测 | 实时调用统计（可暂停轮询、只看异常、按列排序）、按模型聚合（等级分布 / 思考 / 输出 / 平均耗时 / 错误率）、等级对比、最近调用、探测结果与能力声明结局 |
| 诊断 | 宿主契约健康、探测与能力声明、路由与模型能力矩阵、导出 CSV |

页头是页面最重的动作 **一键探测思考档位（写回模型能力声明）**——只测思考档位，不修改采样参数、多模态与全局默认。

> **v0.10.0 界面重构**：从「推理等级单页」升级为「统一模型管理工作台」。行级「跟随全局」表示思考强度、多模态、采样参数**全部**继承全局；任一项在详情里设为自定义后，行级自动显示「自定义」。数字参数改为**失焦或回车才提交**，输入过程中不会保存。第三方插件产生的 `xxx-router` 路由版对用户**完全隐藏**（写入时内部与主版本同步）。所有既有写路径与配置语义零变更。

### 2. 推荐上手路径

1. 安装并重启后保持默认（`high`）——所有支持等级的模型立即获得默认；
2. 打开 **设置 → 统一模型管理 → 模型**：每行默认显示「跟随全局」，摘要里能看到当前生效的思考档位与参数；
3. 想让某个模型深度思考：点开该行 → 思考强度选「自定义」→ 选它支持的最高档（如智谱 GLM-5.3 的 `max`）；行级来源随即变成「自定义」；
4. 想让某个模型支持图片：点开该行 → 多模态选「自定义：文本 + 图像」；
5. 想调采样参数：同一详情里「采样参数 · 温度」输入数值后**按回车或点别处**才保存（输入过程不会写盘）；
6. 打开 **观测** 发一条消息——2 秒内出现新记录，`推理等级` 列即该次请求实际使用的等级。

> **切换模型与「默认」的物化语义**：在模型选择器**切换模型**时，宿主会把该路由的默认等级（本插件按全局等级维护的 `llm-pi-ai.providers.<route>.reasoning`）**物化为会话的显式推理等级**，输入区控件随即显示它——这是宿主的既定行为，切换后的请求以它为显式选择。**显式选择（含切换时物化的默认）永远优先于全局默认，这是设计承诺**，插件不会覆盖你的显式选择；全局默认的作用对象是「无显式等级的调用与各路由默认本身」。因此修改全局等级后：新切换的模型立即拿到新等级；已物化的会话选择保持不变，需要跟随时请在控件重新选择一次。统计面板中 `(默认→高)` 这类标注即对应此机制——入口未显式指定等级的调用，实际请求携带的是所在路由的默认等级。

### 3. 等级档位

| 等级 | 含义 |
|---|---|
| `off` | 不发送推理参数（与不设置等价） |
| `minimal` / `low` / `medium` / `high` | `reasoning_effort` 标准档 |
| `xhigh` | 无标准线值：不向手写模型声明（目录模型按其目录能力） |
| `max` | 原样发送 `reasoning_effort: max`（智谱等实测支持；不支持的模型自动跳过） |

### 4. 配置参考（profile 设置覆盖层——DSH 0.2.0 起由设置页写入 profile 的 cordis.patch.yml `llm-reasoning` entry config；一般无需手改）

```yaml
llm-reasoning:
  enabled: true       # false = 撤销本插件写入的全部默认（能力声明与路由默认一并还原）
  level: high         # 全局默认
  models:             # 模型级默认（键 "provider/model"）
    "zai-coding-cn/GLM-5.3": max
  purposes:           # 辅助调用独立等级（可选）
    compaction: off
    session-title: off
  syncDefaultAgent: false  # true = 全局等级变化同步 agent-default-model.reasoningEffort
  statsPublic: false       # true = 统计端点允许 LAN 访问（默认仅回环）
  # 以下两项由「一键探测」自动维护（probeBlacklist 为 v0.7.1 前版本遗留，兼容保留不再使用）：
  probeBlacklist: {}       # 兼容保留：不再写入/读取（黑名单仅当前会话内存态）
  probeEfforts: {}         # provider/model -> 实测能力声明（不被生成表升级覆盖）
  # v0.10.0 新增（全部可选，旧配置零迁移）：
  defaults:                # 全局默认采样参数 + 预设名
    preset: balanced       # precise / balanced / creative / custom
    params: { temperature: 0.7 }
  modelParams:             # 模型级采样参数覆盖（逐字段优先于 defaults）
    "zai-coding-cn/glm-5.3": { temperature: 0.3, maxTokens: 8192 }
  modelInput:              # 模型级多模态声明（text 恒在；缺省 = 沿用宿主目录）
    "zai-coding-cn/glm-5.3": [text, image]
  appliedInputs:           # 插件写入台账（written/previous），用于撤销与还原
    "zai-coding-cn/glm-5.3": { written: [text, image], previous: [text] }
```

> **关于 topP / topK**：可写入 `modelParams` 并随工作台迁移，但 DSH 0.2.2 的 `GenerateOptions` / `LlmCallControls` 没有这两个字段，插件**不会**把它们发到网关；界面统一标注「预留」。宿主将来支持时，在 `lib/param-registry.js` 把该参数的 `hostSupport` 改为 `active` 并补 `apply` 即可启用。

> ⚠️ **安全警示（v0.7.0）**：`statsPublic: true` 时统计端点允许 LAN 访问，**新增的 `/reasoning-level-stats/probe` 与 `/reasoning-level-stats/probe/apply` 端点随之开放**——LAN 内任何设备无需认证即可触发 1-token 实测请求（产生 LLM 成本），并可写入模型能力声明与 `probeEfforts` 配置。默认请保持回环（`statsPublic: false`）；确需 LAN 暴露时请先在可信网络中评估风险。

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
# 或（含旧版残留清理）：
# Windows: .\install.ps1 -Uninstall      macOS/Linux: ./install.sh --uninstall
```

可选清理：把 `llm-reasoning.enabled` 改为 `false` 重启一次（还原插件写入的字段），然后删除 profile 设置覆盖层中的 `llm-reasoning` entry config（DSH 0.2.0 起；旧版为 settings.yaml 的 `llm-reasoning` 节）。

## 工作原理（简）

- **宿主行**（`- id: llm-reasoning`，dual-face，v0.8.0 起）：设置声明 = 插件 Config volatile 投影（entry id 即命名空间）；监听 `settings/document-updated` 把目标配置**收敛**进 `llm-pi-ai` / `llm-deepseek`（`settings.replace` 整节写，避开 mutate 的数组路径限制）；
- **模型级默认**：`agent/request` 提案 waterfall 注入（仅当提案无显式等级且该模型实测支持）；
- **统计**：`llm/stream` waterfall 只读旁路（采集 usage/finish chunk）；`webServer` 暴露 `/reasoning-level-stats` 供设置页轮询；
- **设置页**：`settings.section` 槽位；读写走标准 wire 面（`api.settings.describe/update/mutate`、`api.llm.models` 能力探测）。

依赖契约（v0.6.0）：`dependencies` 恒为空；`@deepseek-ai/*` 全部为 `peerDependencies`（`*`），由 DSH 维护的 `profiles/node_modules` 平坦回退树解析（dsh-app-boot 的 out-of-tree 官方契约）。宿主 base 组合的 `settings` / `llm` 必需，`llm-pi-ai` / `llm-deepseek` 缺席时自动跳过对应部分；浏览器侧为 web profile 默认组合。

### 宿主兼容面与升级诊断（v0.7.6，host-doctor）

插件对 DSH 宿主的全部契约性依赖（事件名 / 服务名 / 命名空间 / 方法面 / 元数 / 信封形状）收敛在单一模块 `lib/host-compat.js`（客户端面为 `lib/client.js` 内嵌镜像段，机器锚定两平面一致），每条触点携带宿主出处台账——dsh 升级适配的改动面被收敛到"单模块 + 镜像段 + devDeps 锁版行"。

**dsh 升级后第一步**（源码仓库内运行，分钟级给出逐触点结论）：

```sh
npm run host:doctor                      # 缺省自动解析 ~/.dsh/profiles/node_modules
npm run host:doctor -- --tree <宿主树>   # 显式指定（profiles 目录或其 node_modules）
```

输出 11 条触点的 PASS / FAIL / DRIFT / SKIP 表 + 宿主版本清单 + 漂移定位建议；退出码 `0` 无 FAIL / `1` 有 FAIL / `2` 树不可解析。与 CI 判别测试共用同一探针模块（判据零分叉），全程只读。DRIFT 处置 SOP 见 [VERIFICATION.md](./VERIFICATION.md) 第 2.5 节。

## License

MIT
