# dsh-reasoning-level 验证协议（v0.7.6）

> 本文是「插件不得拖垮宿主」的工程契约：从一次真实事故复盘出发，给出
> **架构约束（为什么）、实现规约（怎么防）、验证流程（怎么证）** 三层防线。
> 修改本插件（或任何 DSH out-of-tree 插件）前请先读「事故复盘」。

---

## 0. 事故复盘（2026-08，v0.2–v0.5 期间）

**症状**：安装本插件后 DSH 无法启动（"拉不起"）；修复启动后，带插件运行时
消息发送全部失败（浏览器报 fetch 失败）。另一个插件（dsh-agent-router）
则随 DSH rc 版本升级完全失效。整机级爆炸半径。

**根因判定**（按证据强度排序）：

1. **【确认】依赖声明违背 out-of-tree 契约。** 本插件曾把
   `@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-home-paths` 等宿主运行时包
   声明在 `dependencies`（还钉了 `^0.1.0-rc.7`）。DSH 的官方契约
   （dsh-app-boot `healProfilesModuleFallback`，源码注释原文）是：
   `profiles/node_modules` 是 DSH 自维护的平坦回退树，覆盖 app 依赖闭包中
   **每个包的一个链接**，"out-of-tree 插件的 peer dependencies 通过这棵树解析"。
   插件自带 `dependencies` 意味着要求包管理器把这些宿主包**再装一份**——
   版本钉死与 rc 漂移直接冲突；dsh-agent-router 把 `dsh-llm` 等钉在
   `^0.1.0-rc.6`，宿主升 rc.7 后即全断，是同一类病。
2. **【确认】自制安装器对撞 DSH 自愈树，制造目录反射环。** 旧 install.ps1
   把插件 junction 进 `profiles/node_modules`（DSH 自愈机制拥有的目录），
   又把整个 `profiles/node_modules` junction 回插件源码目录当依赖树：
   `profiles/node_modules/X → src/X` 且 `src/X/node_modules → profiles/node_modules`。
   任何沿该环走的目录枚举/解析都可能无限递归。一个根因同时解释
   "拉不起"与"服务卡死→浏览器 fetch 失败"两个症状。
3. **【确认】渲染崩溃 bug 随 v0.5.0 发布。** `StatsPanel` 中残留越界标识符
   `t('recentCalls')`（i18n 改造漏改），统计加载完成即 `ReferenceError`。
   之所以能发布，是因为没有任何验证执行过"数据加载完成"的渲染路径。
4. **【高危隐患，已消除】设置脱敏视图写回。** 旧代码用
   `settings.describe({redactSecrets:true})` 读、`settings.replace()` 整节写。
   脱敏视图会**移除** `role('secret')` 字段——一旦目标 schema 未来出现
   secret 字段，整节写回就会静默清空用户密钥。llm-pi-ai 今天没有 secret
   字段（凭证走 credentials 服务），但安全性不能押在别人的 schema 演进上。
5. **【架构教训】注册/钩子失败曾被允许升级为挂载失败。** profile 根组合里
   一行加载失败即可让整个 DSH 启动失败。插件任何单点异常（settings
   命名空间冲突、webServer 路由重复、依赖缺号）都必须就地降级为日志，
   不允许冒泡成 boot 级故障。

---

## 1. 架构约束（改代码前必须知道的不变量）

| # | 不变量 | 违背后果 |
|---|---|---|
| A1 | `dependencies` 恒为空；宿主包（`@deepseek-ai/*`）一律 `peerDependencies`，版本 `*` | 依赖树分叉 / 版本漂移 → 宿主或插件整体失效 |
| A2 | 零安装副作用：不动 `profiles/node_modules`（DSH 自愈树）、不手改 `cordis.patch.yml`、不写 `settings.yaml`；一切经 `dsh plugin --profile <P> add/remove` | 目录环 / 双重挂载 → DSH 无法启动 |
| A3 | 最小接缝：不 import 非必需的宿主包；能用 node 内置（fs/path/os）解决的绝不多一个依赖 | 单个包在宿主树缺席即成启动引信 |
| A4 | 一切注册与钩子可失败：`settings.register`、`webServer.register`（重复路由）、事件钩子、持久化——任何异常就地捕获降级，插件"部分可用"永远好过"宿主不可用" | profile 挂载失败 → 整机拉不起 |
| A5 | 请求路径纯旁路：`agent/request` / `llm/stream` 钩子抛任何异常都必须等价于"本插件不存在"；绝不改冻结请求（loop 请求有 frozen 不变量校验） | 消息发送路径被插件破坏 |
| A6 | 对他人命名空间只做同 schema 内的收敛写（`llm-pi-ai` 自身声明的字段），读原值（不经脱敏视图）、写前 diff、失败回滚 | 配置损坏 → LLM 栈整体失效 |

**每次升级 DSH 后**：rc 版本的事件/服务契约可能漂移（router 事故实证）。
第一步先跑「层 -1 宿主兼容面诊断」（见第 2.5 节，FEAT-002，分钟级），
再跑第 3 节金丝雀，最后让工作 profile 接触新版本。

## 2. 实现规约（本仓库的落地检查点）

- `package.json`：`"dependencies": {}`；peers：cordis / schemastery /
  dsh-settings / dsh-llm（`*`）。CI 强制（见下）。
- `lib/index.js`：
  - 导入面 = schemastery、dsh-settings、node:fs、node:path、node:os，仅此五项；
  - DSH 主目录解析用本地 `resolveDshHomeSafe()`（`$DSH_HOME || ~/.dsh`），
    失败 → 统计持久化降级为内存态；
  - `settings.register` / 两处 `webServer.register` / `boot()` / 全部钩子体
    都有捕获与降级路径；
  - `llm/stream` 统计记录可空（`record === null` 时旁路全静默）。
- `lib/client.js`：组件不引用作用域外未定义标识符（冒烟测试覆盖）。
- v0.7.0 探测面（新接缝，同 A5 纪律）：
  - 探测请求 = `llm.stream` 1-token ping，`messages` 必须是 ContentBlock 数组
    （`[{type:'text', text}]`）——字符串 `content` 会触发适配器
    `content.some is not a function`，这是 v0.6 探测"全部失败"的根因；
  - 探测请求带 `probe: true` 标记，`llm/stream` 旁路统计与注入，观测数据零污染；
  - 单次探测带 30s 超时（AbortController），单模型并发 3；并发 /probe 同一模型走互斥队列串行化（v0.7.2 MAINT-017——重复点击/双窗口不互相覆盖）；
  - 分类：`UNSUPPORTED_REASONING_EFFORT` → 该次探测结果 rejected 列表（不入黑名单、
    不持久化——探测是"测量"不是调用，v0.7.1 MAINT-013）；真实调用被网关拒绝
    （agent/request-error / 流内 finish error）→ 仅会话内存黑名单（注入跳过，
    不持久化，重启清零）；限流/超时 → blocked（不黑名单，不误判）；
  - 固化：实测可用等级写回 `llm-pi-ai` 模型能力声明并持久化 `probeEfforts`
    （重启后不再被生成表升级覆盖）；手写声明保 wire 并入 working 新档位
    （保留用户档位，实测可用的新档位自动追加），本插件生成/未声明的声明
    替换为 working 集；（v0.7.2 MAINT-017：并入语义取代"永不覆盖"，7 键全量
    声明识别为生成形状——自动升级而非误判手写）
  - 固化写走既有 `settings.replace` 整节替换 + `settings/updated` 收敛路径，
    不新增写面。
- 安装器（install.ps1 / install.sh）：清理旧残留（只删链接本体）、安装前
  依赖策略自检、调用官方 `dsh plugin` 通道；`-Link/--link` 模式带前置自检
  （从源码目录实测解析宿主导入面 `@deepseek-ai/schemastery` / `dsh-settings`，
  缺依赖即拒绝并引导 `file:`）——杜绝 link: 缺 node_modules 导致的整机启动失败。

## 2.5 dsh 升级后第一步：宿主兼容面诊断（FEAT-002）

```powershell
# 缺省——自动解析 $DSH_HOME||~/.dsh 下的 profiles/node_modules
npm run host:doctor

# 显式指定宿主树（profiles 目录或其 node_modules 皆可）
npm run host:doctor -- --tree C:/Users/<you>/.dsh/profiles/node_modules
# 判别测试同款活树断言：DSH_HOST_TREE=<树> node --test
```

- **输出**：断言清单逐触点表（PASS/FAIL/DRIFT/SKIP + 一行证据）+ 宿主版本
  清单 + 逐 FAIL/DRIFT 漂移定位建议（出处台账 anchor → 锚串搜索 → 宿主
  changelog/diff）。与判别测试共用同一探针模块（test/host-probes.mjs）——
  测试绿 ⟺ doctor 绿，判据零分叉。全程只读零写入零网络。
- **退出码**：`0` 无 FAIL（DRIFT 允许 0 但醒目输出）；`1` 有 FAIL；`2` 树不可
  解析或零断言执行（先确认树布局——包不可解析 ≠ 契约 FAIL，SKIP-UNRESOLVED
  分级归因）。
- **分级**：T 级（源码文本锚串）断言失败在活树 = **DRIFT**（可能是宿主重构
  而行为未变——BM-2 防误报）；在 devDeps 锁版基线 = **FAIL**（锁版不该漂）。
  B 级（vm 加载真实工件的行为判别）失败不分源恒 FAIL。
- **双工件源**：工件源① = devDeps 锁版基线（CI 恒断言 fail-closed——锁版含
  dsh-agent-loop/dsh-llm/dsh-host-webserver，事件名/校验结构/webServer 面
  均在基线域内）；工件源② = `DSH_HOST_TREE` 活树（在场即断言/缺席即逐条
  显式 SKIP 带原因；旧名 `DSH_HOST_PACKAGES` 保留为别名）。

**DRIFT 复核 SOP（BM-2——防「忽略红灯」习惯）**：

1. 复核：按 doctor 的定位建议读宿主源码，判定是「行为已变」还是「仅锚串
   过时（重构/改名/移位，公开行为未变）」；
2. 更新锚点/锚串：行为已变 → 按新契约同步 `lib/host-compat.js` +
   `lib/client.js` 镜像段（**同一变更单元**）+ devDeps 锁版 bump；仅锚串
   过时 → 更新探针锚串与 `HOST_PROVENANCE` 出处行；
3. **一个 commit** 承载本次复核结论，判别测试红→绿闭环。

## 3. 验证流程（三层防线）

### 层 0：静态门禁（每次提交，CI 自动）

`.github/workflows/ci.yml` 的 check job：

1. `node --check lib/index.js && node --check lib/client.js`（语法）；
2. **依赖策略**：`dependencies` 必须为空、`peerDependencies` 非空、
   `dependencies` 中不得出现 `@deepseek-ai/*`；
3. **渲染冒烟** `node scripts/client-smoke.mjs`：以最小 React 存根执行
   client.js 的 apply() 与全部组件的"加载中 → 数据加载完成"两条渲染路径。
   （v0.5.0 的 `t is not defined` 崩溃正是被此门禁拦截的 bug 类型——
   该脚本先在带 bug 的代码上复现了失败，修复后通过。）
4. bundle 资产齐备（cordis.patch.yml / install 脚本 / dsh.bundle 声明）。

本地等价：`node --check lib/*.js && node scripts/client-smoke.mjs`。

### 层 1：金丝雀验证（进入任何真实 profile 之前，必做）

金丝雀原则：**绝不让未验证的插件行出现在工作 profile 的组合里**。
用一次性 profile 试验，失败最坏损失 = 删一个目录。

> **金丝雀实战记录（2026-08，本轮安装时抓到的第四个坑）**：pnpm 会把
> 裸目录安装规格归一化为 `link:`。`link:` 下 Node 从**源码真实路径**
> 向上解析依赖，永远够不到 `$DSH_HOME/profiles/node_modules` 平坦回退树
> → 插件导入宿主包 peers 全部 `ERR_MODULE_NOT_FOUND` → **整机启动失败**
> （又是"拉不起"级症状，换了个马甲）。结论：安装规格必须显式 `file:`
> （快照）；`link:` 仅供源码目录自带完整 node_modules 的开发场景。
> 本仓库安装器已强制 `file:`，CI 无法覆盖此项——**只有金丝雀能拦住**。

```powershell
# 1) 金丝雀安装（一次性 profile，绝不碰 web；必须显式 file: ——见下方实战记录）
dsh plugin --profile canary add file:D:/AI/agent/deepseek/plugins/thinking/dsh-reasoning-level

# 2) 金丝雀启动 + 探活（DSH_HOME 隔离到临时目录更彻底）
$env:DSH_CANARY = "$env:TEMP\dsh-canary"
dsh --profile canary web          # 观察启动日志无 failed fiber / 无等待服务的行

# 3) 冒烟：浏览器打开金丝雀端口
#    a. 发一条消息 → 模型正常回复（请求路径未被破坏）
#    b. 设置 → 统一推理等级 → 页面正常渲染、统计 2s 内出现记录
#    c. curl http://127.0.0.1:<port>/reasoning-level-stats → 200 + JSON
#    d. 切换全局等级 high ↔ max → 下一条消息统计里 effort 列变化
#    e. 设置页点「一键探测全部模型并固化配置」→ 逐模型出结果（可用/拒绝/其他），
#       完成后能力声明写入 settings.yaml（llm-reasoning.probeEfforts）；黑名单仅
#       当前会话内存态（stats 端点 payload.blacklist 可见，不再写 probeBlacklist）；
#       curl POST /reasoning-level-stats/probe/apply 幂等返回修正后的写入数

# 4) 清理
dsh plugin --profile canary remove dsh-reasoning-level
```

通过标准：四步全绿，且金丝雀 DSH **启动日志零插件相关告警**。

### 层 2：工作 profile 上线与回滚（金丝雀通过后）

```powershell
# 0) 快照（回滚点，30 秒）
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" "$env:TEMP\web.package.json.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" "$env:TEMP\web.lock.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" "$env:TEMP\web.patch.bak"

# 1) 安装 + 重启 DSH，重复层 1 的第 3 步冒烟
dsh plugin --profile web add file:D:/AI/agent/deepseek/plugins/thinking/dsh-reasoning-level

# 2) 回滚（任一冒烟失败时）
dsh plugin --profile web remove dsh-reasoning-level
#   若组合文件异常，用第 0 步快照覆盖回去后重启
```

**升级 DSH 后的追加规则**：先在金丝雀 profile 用新 dsh 二进制重复层 1
（rc 契约漂移在此暴露），再重启工作 profile。

### 请求层最硬验证（可选，排查时用）

会话日志归档每次请求的最终配置：

```sh
zstd -dc ~/.dsh/sessions/<会话目录>/session.jsonl.zstd | grep '"type":"request/header"'
# reasoningEffort 字段 = 该次请求实际携带等级
```

---

## 4. 维护者检查单（PR 自查）

- [ ] `dependencies` 仍为空？新增宿主包了吗——真的需要吗（A3）？
- [ ] 新副作用全部有捕获降级路径（A4）？
- [ ] 新钩子异常时请求路径等价于无插件（A5）？
- [ ] `node scripts/client-smoke.mjs` 覆盖了新渲染路径？
- [ ] 触碰了宿主契约面（host-compat.js / client.js 镜像段）？——两文件必须
      同一变更单元，且 `npm run host:doctor` 对活树全 PASS / DRIFT 已复核；
- [ ] 金丝雀四步过了再上工作 profile？
