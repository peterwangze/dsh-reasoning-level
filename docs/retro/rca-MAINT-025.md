# RCA 报告 — MAINT-025：v0.7.3 设置界面按钮与设置逻辑大面积失效

- **Task ID**: MAINT-025（P0，目标版本 0.7.4）
- **阶段**: 阶段 1 只读分析（本报告为唯一写入产物；未修改任何产品代码/测试/治理记录）
- **分析人**: Maintenance Agent
- **日期**: 2026-09-05
- **症状（用户报障原文，唯一症状事实）**: "这次dsh升级适配之后，几乎所有的设置界面的按钮和设置逻辑都失效了，需要定位分析并增强防护，避免问题回归。"
- **宿主环境**: DeepSeek Harness 0.1.2-rc.1（dsh-api-remotes 0.1.2-rc.1 / dsh-api-gateway 0.1.2-rc.1 / dsh-client-connection 0.1.2-rc.1 / dsh-settings 0.1.2-rc.1，均经本机安装树实测核实版本号）
- **插件产物**: dsh-reasoning-level 0.7.3（lib/client.js SHA256 `C85EE5B909E300DEED4FD5307212CDEEDB47CC2562838A9407FB2849177B7894`，960 行 / 53240 字节）

---

## 0. 结论速览

**已证实根因（机制级，可执行复现）**：MAINT-022 的 hostApiFace 适配层把 `remote.settings.update/mutate` 按 **2 个位置参数** 转发（`lib/client.js:910/914`），而宿主 0.1.2-rc.1 的 typed remote 描述符声明 **3 个参数**（`ns, patch/ops, expectedRevision`），且客户端网关 invoker 在发起 RPC 前执行**严格元数守卫**（`dsh-api-gateway lib/client.js:1626-1633`：`values.length !== expected` 即 throw）。因此**每一次设置写入**（全局开关/全局等级/同步 agent 开关/模型级默认增改删/辅助调用等级）都在宿主侧被元数守卫拒绝：

```
client api: @deepseek-ai/dsh-api-settings-controller#settings/update expected 3 argument(s), got 2
```

异常以 rejected promise 到达 `change()` 的 `.catch`（`lib/client.js:782`），页面只显示笼统的「保存失败」，设置值不落盘。而**读路径零参调用恰好匹配**（`describe()`/`modelCatalog()` 描述符均为 0 参）——这正是"渲染正常（MAINT-022 验收「可以了」）但按钮/设置逻辑全部失效"的完整解释。

**修复方向（供 Developer 实现，本阶段未写码）**：适配层补第三参（最小修复传 `undefined`，宿主文档化语义 = "无条件写入"；`dsh-api-settings-controller lib/index.js:443-472`）。

---

## 1. 交互点清点（设置页全部用户动作点，file:line 调用链）

数据面单点：`hostApiFace(ctx)`（lib/client.js:874-929）收敛全部宿主调用；页面消费旧信封 `{result:{ok,value|error}}`（envelopeOf，:882-894）。模块 `inject = ['slots','locale','remote','remote.settings','remote.session']`（:931）；`apply`（:933-954）注册 `settings.section` slot 并注入 api。

| # | 交互点 | 事件 → 函数（file:line） | host API 调用形状（适配层实传） | 判定 |
|---|--------|--------------------------|-------------------------------|------|
| 1 | 全局开关 enabled | checkbox onChange → `change({enabled})`（:810→:766） | `api.settings.update({ns,patch})` → `remote.settings.update(ns, patch)` **2 参** | ✗ 元数拒绝 |
| 2 | 全局默认等级 select | onChange → `change({level})`（:818→:766） | 同上 **2 参** | ✗ |
| 3 | 同步默认 agent 模型等级 | checkbox onChange → `change({syncDefaultAgent})`（:828→:766） | 同上 **2 参** | ✗ |
| 4 | 模型级默认·添加 | addEntry → `onChange({models})`（:601-606→:766） | update 路径 **2 参** | ✗ |
| 5 | 模型级默认·等级下拉 | setLevel → `onChange({models})`（:607-611→:766） | update 路径 **2 参** | ✗ |
| 6 | 模型级默认·删除 | removeEntry → `onChange({removeModelKey})`（:612-614）→ mutate 分支（:770-771） | `remote.settings.mutate(ns, ops)` **2 参** | ✗ |
| 7 | 辅助调用等级（compaction/session-title） | setPurpose → `onChange({purposes})`（:690-695→:766） | update 路径 **2 参** | ✗ |
| 8 | 一键探测 | probeAll（:371-424，按钮 :464-469） | `fetch POST /reasoning-level-stats/probe`（:387，直连 HTTP，不经 remote face；探测目标来自 modelCatalog ✓） | ✓ 不受影响 |
| 9 | 探测固化 | probeAll 尾部 `fetch POST /reasoning-level-stats/probe/apply`（:405） | 直连 HTTP（服务端 dsh-settings 面不变） | ✓ |
| 10 | 导出 CSV | exportCsv（:426-441，按钮 :470） | 纯客户端 Blob | ✓ |
| 11 | 实时统计轮询 | `fetch /reasoning-level-stats` 每 2s（:338-345） | 直连 HTTP | ✓ |
| 12 | 模型列表加载 | ModelDefaults :563 / StatsPanel :354 → `api.llm.models({})` | `remote.session.modelCatalog()` **0 参** | ✓ |
| 13 | 页面初始读取 | refresh → `api.settings.describe({})`（:729） | `remote.settings.describe()` **0 参** | ✓（渲染正常的原因） |

写路径失败的用户可见表现：`change()` 的 `.catch(() => setNotice(t('saveFailShort')))`（:782）吞掉宿主错误详情 → 每个设置操作显示「保存失败」，值不落盘；探测目标/模型下拉/统计/导出正常 → 与"**几乎所有的**按钮和设置逻辑失效"吻合（失效集合 = 全部写路径，可用集合 = 全部直连 HTTP 读路径与纯客户端动作）。

## 2. 契约比对（ground truth = 宿主 0.1.2-rc.1 安装树源码/.d.ts，非记忆非推测）

宿主 checkout：`C:\Users\peter\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（下称 `<host>`）。

| # | 比对点 | 插件侧（lib/client.js） | 宿主侧 ground truth | 判定 |
|---|--------|------------------------|--------------------|------|
| C1 | settings.describe 元数 | 0 参（:907） | 描述符 `parameters: []`（dsh-api-remotes lib/client.js:5051-5067）；`.d.ts` `describe: () => Promise<RemoteResult<SettingsDescribeValue>>`（dsh-api-settings-controller lib/typert.remote-client.d.ts:19） | ✓ 匹配 |
| C2 | settings.update 元数 | **2 参** `(ns, patch)`（:908-911） | 描述符 `parameters: [ns, patch, expectedRevision]`（api-remotes lib/client.js:5216-5253，expectedRevision `acceptsUndefined: true` 但仍在参数表内）；`.d.ts` `update: (ns, patch, expectedRevision: number \| undefined)`（typert.remote-client.d.ts:24，**第三参非 TS optional，必须占位**） | **✗ 不匹配（本根因）** |
| C3 | settings.mutate 元数 | **2 参** `(ns, ops)`（:912-915） | 描述符 `[ns, ops, expectedRevision]`（api-remotes:5069-5117）；`.d.ts` `mutate: (ns, ops, expectedRevision: number \| undefined)`（typert.remote-client.d.ts:20） | **✗ 不匹配（本根因）** |
| C4 | session.modelCatalog 元数 | 0 参（:919） | 描述符 `parameters: []`（api-remotes:8267-8283，result=裸 ModelCatalog：default/routableProviders/groups/failures，:7794-7823） | ✓ 匹配 |
| C5 | 响应信封 | envelopeOf 期望 `{ok, value\|error}` 直面（:882-894） | 网关 invoker 确认包信封：`return {ok:true, value}` / `{ok:false, error}`（dsh-api-gateway lib/client.js:1601-1610） | ✓ 匹配（MAINT-022 此项假设正确） |
| C6 | 异步语义 | `await` + envelopeOf（:907-915） | invoker 为 async，错误经 rejected promise（元数 throw 发生在 try 块之前，gateway:1594-1597 → 1626-1633） | ✓ 形态一致（但元数异常被 change 的 catch 吞成「保存失败」，:782） |
| C7 | 官方消费先例 | — | `dsh-client-ui-settings lib/client.js:1045`：`await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision)` —— **官方恒三参**，revision 来自 describe 结果 `namespaces[].revision`（api-remotes:4755）做乐观并发，`!response.ok` 时 recover() 重读（:1040-1055）；`ctx.remote.settings.describe()` 零参（:1299） | 佐证 C2/C3 |
| C8 | 服务端对照（probe/apply 为何不受影响） | lib/index.js 服务端走 dsh-settings/api-settings-controller 服务端面 | `update(ns, patch, expectedRevision)` / `mutate(ns, ops, expectedRevision)`，文档注释："`undefined` writes unconditionally"（dsh-api-settings-controller lib/index.js:443-472） | ✓ 服务端 2 参调用合法（expectedRevision 省略） |

**元数守卫（拒绝发生的精确位置）**——`<host>\dsh-api-gateway\lib\client.js:1626-1633`（`prepareInvocation`，直调用时 `projection` 为 undefined）：

```js
const expected = descriptor.parameters.length - (projection?.parameterIndex === void 0 ? 0 : 1);
const hasCallerSignal = descriptor.cancellation !== void 0 && values.length === expected + 1;
if (values.length !== expected && !hasCallerSignal) {
  const contract = ...`${String(expected)} argument(s)`...;
  throw new Error(`client api: ${endpoint} expected ${contract}, got ${String(values.length)}`);
}
```

update/mutate 描述符均无 `cancellation` 字段（api-remotes:5216-5258 / 5069-5117 实读确认）→ `expected = 3`，2 参调用必 throw。调用链：`RemoteNamespaceService` 方法 getter（gateway:1698-1710）→ `invokeMethod`（:1581）→ `invoke`（:1594，`prepareInvocation` 在 try 之前）→ **rejected promise**。

## 3. 可执行证明（进程内，零浏览器；产物即本次会话命令输出）

方法：以 vm 加载 dual-face 包（`window.__ModuleLoader__.load` 桩），

- **Half B（插件侧实测）**：加载工作树 lib/client.js（hash 与安装拷贝一致，见 §5 假设②），经 `apply(ctx)` 提取真实适配层 api，对记录型 fake remote 调用四个数据面方法，捕获适配层实际转发参数量：

  ```
  ADAPTER-FORWARDED: [["describe",0],["update",2],["mutate",2],["modelCatalog",0]]
  ```

- **Half A（宿主侧实测）**：加载 `<host>\dsh-api-remotes\lib\client.js`，经真实 `apply()` → `ctx.remote.$mount` 捕获全部 12 个真实 contribution，取 `@deepseek-ai/dsh-api-settings-controller` 的 settings/update、settings/mutate、settings/describe 与 `@deepseek-ai/dsh-api-session-controller` 的 session/modelCatalog 真实描述符，套用**逐字复制**的 gateway 元数守卫（gateway:1626-1633，仅 endpointOf→descriptor.id 的消息保真替换）：

  ```
  HOST-GUARD describe() [adapter forwards 0 args]        -> ARITY-OK
  HOST-GUARD update(ns,patch) [adapter forwards 2 args]  -> THROWS: client api: @deepseek-ai/dsh-api-settings-controller#settings/update expected 3 argument(s), got 2
  HOST-GUARD update(ns,patch,undefined)                  -> ARITY-OK
  HOST-GUARD mutate(ns,ops) [adapter forwards 2 args]    -> THROWS: client api: @deepseek-ai/dsh-api-settings-controller#settings/mutate expected 3 argument(s), got 2
  HOST-GUARD mutate(ns,ops,undefined)                    -> ARITY-OK
  HOST-GUARD modelCatalog() [adapter forwards 0 args]    -> ARITY-OK
  ```

结论：读路径（describe/modelCatalog，0/0）通过；写路径（update/mutate，2/3）被宿主元数守卫确定性拒绝；第三参显式 `undefined` 即通过（修复方向实证）。

> **消息保真度澄清（R0 审查 F-R2/F-R3 补记，2026-09-05）**：上方 THROWS 行中 endpoint 段（`@deepseek-ai/dsh-api-settings-controller#settings/update`）为 harness 替换后形式——真实 `endpointOf` = `${namespace}/${method}`（dsh-api-gateway lib/client.js:1781-1783），真实 throw 消息形如 `client api: settings/update expected 3 argument(s), got 2`。守卫的元数判定逻辑逐字保真；endpoint 段非保真（以 descriptor.id 替代，可读性取舍）。用户在页面从未见过原始消息——真实抛点被 change() catch 吞为「保存失败」文案（lib/client.js:782；§9.2 用户端文案未直接观测仍成立）。

## 4. 候选假设逐一证实/证伪

### 假设① 写路径与宿主契约不符 —— ✅ 证实（精确化：元数不足，非信封/方法名错误）

- 证据：§2 C2/C3 + §3 可执行证明。方法名（update/mutate）、位置参数语义（ns, patch/ops）、信封形状（{ok,value|error}）全部正确（C5）；唯一断裂 = 缺第三参 `expectedRevision`。
- 读路径可用解释"渲染正常"（C1/C4 + MAINT-022 验收「可以了」）。

### 假设② 安装拷贝与工作树版本偏移 —— ❌ 证伪

- `.package-map.json`（`C:\Users\peter\.dsh\profiles\web\node_modules\.package-map.json`）实测：`"dsh-reasoning-level":"link:D:/AI/agent/deepseek/plugins/thinking/dsh-reasoning-level"` —— **link: 直连工作树**（非快照拷贝；安装树内含今天 15:26:25 生成的 `.governance/change-triage/MAINT-025.json`，08:28 的快照不可能包含 → live link 实证）。
- SHA256 实测：安装路径 lib/client.js = 工作树 lib/client.js（`C85EE5B9…`）；lib/index.js 同（`0A4C5241…`）。安装 package.json version=0.7.3。
- 结论：不存在偏移；失效代码就是工作树这份 960 行 client.js。（MAINT-022 验收期"快照拷贝需手动刷新"的认知在当前安装形态下已不成立——但这是 link: 语义，非本次故障因素。）

### 假设③ UX-001 重构事件绑定/状态刷新回归 —— ❌ 证伪

- `git diff v0.7.2 v0.7.3 -- lib/client.js` 实测：全部 handler 行（`onChange: (event) => change({...})` ×3、`onChange: change` ×2、`onClick: probeAll/exportCsv/addEntry`）均为**语义等价的 remove+re-add**（仅样式常量 → btnStyle/设计令牌），无一处绑定语义变化。
- v0.7.3 中写路径唯一功能变更是 MAINT-022 适配层（diff 中 `+ describe/update/mutate` 三行即 hostApiFace 转发体）。
- 机制佐证：若 UX-001 绑定回归，症状应为"按钮无响应"（change 不触发）；实际症状是宿主网关在 UI 之前确定性 throw（§3）——与 UI 层无关。且 UX-001 仅改渲染层，不可能产生宿主元数错误。

## 5. 5-Why（≥3 层，含系统性层）

1. **为何设置按钮/逻辑失效？** 每一次设置写入经 hostApiFace 以 2 个位置参数调用 `remote.settings.update/mutate`，宿主 0.1.2-rc.1 网关元数守卫要求 3 参（`ns, patch/ops, expectedRevision`），RPC 发起前确定性 throw（gateway:1626-1633）；异常被 `change()` 兜底 catch 吞成「保存失败」（client.js:782）。
2. **为何适配层只传 2 参？** MAINT-022 从描述符行号与"位置参数 + {ok,value|error}"重建新面（client.js:864-869 注释），捕获了位置化与信封，但**漏掉第三参 expectedRevision**——`.d.ts` 中它写作 `number | undefined`（非 `?` optional，必须占位），运行时还有严格元数守卫；适配层按旧单对象面 `{ns, patch}` 直译成 2 个位置参数。
3. **为何 47/47 + client-smoke 全绿、双审查（R0 APPROVED_WITH_NOTES 0 blockers）都没拦住？** 判别测试组（test/client-host-face-compat.test.mjs:95-100）与冒烟（scripts/client-smoke.mjs:122-131）的 remote 桩都是 `update: async (ns, patch) => ({ok:true,...})` 形状的**普通 JS 函数**——JS 桩不校验元数（多传少传都不报错），断言只检查桩被调用时的记录值。**桩形状本身抄自适配层的假设**（桩 ↔ 适配层循环自证），等于用被测物的假设验证被测物。审查对照的"宿主契约"同为注释里那组行号/形状假设，无任何**可执行的宿主工件**参与验证。这是 MAINT-014 假绿先例（mock 全绿但真实入口校验层拦截）在客户端面的复发——两次都是"测试桩替代了真实契约"。
4. **为何验收链允许"仅验证渲染"就放行客户端面改造？**（系统性层） MAINT-022 的 M7.7 验收 = 页面渲染正常（describe 读路径可见），**验收清单里没有"执行一次真实写路径"这一步**；同时测试策略把"node --test 全绿 + smoke exit 0"当作客户端面充分覆盖，不存在"判别测试必须对齐真实宿主形状（非 mock 自证）"的门槛。MAINT-014（服务端 llm.stream 本地校验层）与 MAINT-025（客户端网元守卫）证明：凡是"宿主在到达业务逻辑之前设卡"的位置，本项目的 mock 防护网结构性失明。
5. **为何这个基础设施缺口持续存在？**（系统性根因） 宿主客户端面以 dual-face 浏览器 bundle（`window.__ModuleLoader__`）分发，node 下不能直接 require，项目至今没有"在 CI 内执行真实宿主客户端工件"的设施；devDeps 精确锁版实践（MAINT-021）只覆盖了服务端面（dsh-settings，普通 ESM 可直接 import），从未延伸到客户端面（dsh-api-remotes/dsh-api-gateway bundle）。于是每一代客户端面适配的"契约正确性"只能靠人读注释/行号，错误必然漏网。

## 6. 同类扫查（grep 同模式）

| 扫查对象 | 结果 | 判定 |
|----------|------|------|
| 本仓库 `remote.*` 全部消费点 | 仅 hostApiFace 一处收敛（client.js:874-929）；4 个方法（describe/update/mutate/modelCatalog）已逐点比对 | 除 C2/C3 外无其他断裂 |
| `settings.replace` | 客户端未使用；服务端 probe 路径用的是服务端面（C8，合法） | 无同类断裂 |
| 直连 HTTP 调用点（/reasoning-level-stats、/probe、/probe/apply） | 不经 remote face；服务端码 hash 未变（link: 安装）+ dsh-settings 0.1.2-rc.1 服务端套件 47/47 真包执行 | 不受本次故障影响 |
| 测试/冒烟桩同模式 | test/client-host-face-compat.test.mjs:95-100（2 参 update/mutate 桩 + :305 起 mutate 断言锁定的也是 2 参记录形状）；scripts/client-smoke.mjs:127-128（2 参桩）、:105-106（旧信封桩） | **同模式隐患**：桩不校验元数/形状，任何未来契约漂移仍会假绿 |
| 跨插件同根因家族 | dsh-agent-router FIX-028（MAINT-022 已记同源先例）——同网关元数守卫影响一切适配 remote 面的插件 | 建议（超出本仓库范围）：共享"真实宿主工件判别 harness" |
| hostApiFace 内其余健壮性 | requireSettings/requireSession 以 typeof function 校验（:895-904）——getter 属性 typeof==='function' 成立，无断裂；llm.models 对 catalog 形状有防御（:920-925） | 无发现 |

## 7. 修复方案（供 Developer 实现；本阶段未改码）

**F1（P0，最小修复，一处单点）** lib/client.js hostApiFace 补第三参：

- :910 `return envelopeOf(await requireSettings().update(input.ns, input.patch, input.expectedRevision))`
- :914 `return envelopeOf(await requireSettings().mutate(input.ns, Array.isArray(input.ops) ? input.ops : [], input.expectedRevision))`

  宿主侧 `expectedRevision === undefined` 语义 = "无条件写入"（dsh-api-settings-controller lib/index.js:443/454/467 文档注释），wire 层 `acceptsUndefined` + args 对象按 wire 名装填（gateway:1643-1648，undefined 不入 args）——显式 `undefined` 完全合法。`input.expectedRevision` 透传（当前页面恒 undefined）为后续乐观并发预留，不构成行为变更。

**F2（P0 配套，同 commit 内的注释纠偏）** client.js:864-869 契约注释补记元数契约：update/mutate 三参（第三参必须占位，值可 undefined）、describe/modelCatalog 零参、网关元数守卫位置（gateway:1626-1633）——防止下一个适配者重蹈。

**F3（P0 配套，测试与冒烟桩同步）** test/client-host-face-compat.test.mjs:96-97 与 scripts/client-smoke.mjs:127-128 的桩签名同步为三参并**加元数断言**（详见 §8-a/b），避免修复被旧桩继续"验证"。

**F4（后续硬化，独立任务建议，非本次 P0 范围）** 乐观并发对齐官方模式：页面从 describe 结果读取 `namespaces[].revision`（api-remotes:4755），写路径传入并在 `{ok:false}` 时重读恢复（官方 dsh-client-ui-settings SettingsScope mutate/recover 模式，:1040-1055）。注意与 MAINT-019 P2-2（服务端自动收敛会 bump revision）联动评估，避免引入新的写冲突失败面——先评估再排期。

## 8. 回归防护方案（用户明确要求"增强防护，避免问题回归"；方案给 Developer，本阶段不实现）

**(a) 判别测试对齐真实宿主形状（核心——杜绝 mock 自证）**
新增 `test/host-face-contract.test.mjs`（判别式，非桩式）：
1. devDeps 精确锁版追加 `@deepseek-ai/dsh-api-remotes@0.1.2-rc.1`（MAINT-021 先例：锁宿主版本，套件即针对该宿主执行）；
2. 测试内用 §3 同款 vm dual-face 加载器加载**真实 dsh-api-remotes bundle**，经真实 `apply()` 捕获真实描述符；
3. 加载**真实插件 lib/client.js**（react 桩 + ModuleLoader 桩，§3 Half B 同款），捕获适配层对每个方法的**实传参数量**；
4. 断言：适配层实传元数 === 真实描述符 `parameters.length`（describe 0/0、update 3/3、mutate 3/3、modelCatalog 0/0）+ 实传形状（ns 为 string、ops 数组、第三参存在）；
5. 守卫执行：用真实描述符 + 逐字 gateway 元数守卫（gateway:1626-1633 常量复制进测试并注明来源行号）驱动正反例——**当前缺陷在 GREEN 前该测试必须 RED**（TDD 判别组纪律，MAINT-022 先例）。
   效果：任何宿主 bump 或适配层漂移导致的元数/形状断裂在 CI 即红，不依赖浏览器。

**(b) 冒烟/测试桩增强**
- client-smoke.mjs：remoteSettings 桩从"记录型 ok 桩"升级为**契约校验桩**——update/mutate 桩内校验 `arguments.length === 3`、ns 为 string、ops 数组元素形状（`op:'set'+path+value` / `op:'unset'+path`，锚定 api-remotes:4759-4774），违约即 fail；describe/modelCatalog 桩校验 0 参。
- client-host-face-compat.test.mjs：桩同样加元数断言；既有 8 用例保持（页面消费面回归），新增"(MAINT-025) 写路径三参"判别用例。

**(c) 契约快照校验（宿主升级防线）**
- 以真实 `apply()` 提取的描述符生成快照 fixture（如 `test/fixtures/host-remote-face-snapshot.json`：namespace/method/parameters[].name/acceptsUndefined/cancellation），CI 测试"重提取 → diff 快照"，不一致即红并输出可读差异（哪个方法的哪个参数变了）。
- 配套流程（回灌维护 SOP）：宿主 rc 版本升级任务（未来 MAINT-02x）的验收清单固定含三步——①更新 devDeps 锁版与快照（一个 commit 承载一个宿主版本，编程要求 4）②跑 (a) 判别组 ③真实环境 M7.7 验收必含**一次真实写路径操作**（设置页拨动一个开关并确认落盘）——补上本次缺失的验收步骤。

**(d) 无浏览器真实形状探针（可选加固）**
把 §3 的进程内 harness 固化为 `scripts/host-face-probe.mjs`（读安装树/工作树宿主 bundle → 提取描述符 → 比对适配层转发），作为发布前手动/CI 可跑的第三层探针；与 MAINT-014 教训合并沉淀规则："宿主在业务逻辑前设卡的位置（本地校验层/网元守卫），mock 防护网结构性失明，必须有真实工件判别测试"——建议由 Coordinator 评估回灌 stage-development/stage-maintenance 规则。

## 9. 证据缺口清单（诚实声明）

1. **未做浏览器级端到端复现**（本阶段只读约束）：§3 证明已用真实描述符 + 逐字守卫 + 真实适配层捕获闭合机制链，但未在运行中的 DSH web 实例上驱动完整 transport（window → ModuleLoader → gateway → rpc）。残余风险低（失败发生在 rpc 发起之前），阶段 2 由 Developer 以 (a) 判别测试补最终闭环。
2. **用户端实际报错文案未直接观测**：页面 catch 吞错后应显示「保存失败」（client.js:782 代码推断）；用户报障未附截图/文案。若用户实际见到其他文案，需回流核实（不改变根因判定——元数 throw 是机制级确定事件）。
3. **用户报告中的"几乎所有的"**：按本分析，统计面板/探测/导出（直连 HTTP）应仍可用；用户是否实际点过这些未证实。不排除用户环境存在第二叠加因素（如探测按钮因 modelCatalog 空而禁用的观感），阶段 2 用户自验时一并确认。
4. **宿主 checkout 与用户运行实例的一致性**：以本机 npx 缓存 checkout（0.1.2-rc.1，与 MAINT-021/022 治理记录的宿主版本一致）为 ground truth；未对用户 DSH 服务进程做运行时探查（只读红线内未要求）。

## 10. 真实环境操作上报（R4——本任务对真实环境仅只读探查）

全部对工作区外路径的操作均为**只读**（Get-ChildItem/Get-Content/Select-String/Get-FileHash/ConvertFrom-Json），涉及：`C:\Users\peter\.dsh\`（profiles/web/node_modules 目录列表、.package-map.json 读取、安装拷贝 hash 比对）与 `C:\Users\peter\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\`（宿主 checkout 源码/类型读取）。退出码全 0，无任何写/删/移动。唯一写入 = 平台临时区 scratch（`%TEMP%\dsh-IHDJou\maint025-rca-proof*.cjs` 共 3 个，node 进程内证明用），每个用后即删（已核实删除）。未触碰 $DSH_HOME 下任何配置文件的写语义；R1 三选一不适用（无写操作、无状态变更）。

---

## 附：硬门槛自检

| 门槛项 | 状态 |
|--------|------|
| 开发原则 1（结论基于事实） | ✅ 全部结论附 file:line / 命令输出 / hash；假设均标注待证/已证 |
| 每交互点 file:line 调用链 | ✅ §1（13 项全覆盖） |
| 根因有宿主侧 ground truth | ✅ §2（api-remotes/gateway/typert.remote-client.d.ts/api-settings-controller 四源交叉） |
| 三假设逐一证实/证伪 | ✅ §4（证伪亦有证据：hash/link:/git diff） |
| 5-Why ≥3 层含系统性层 | ✅ §5（5 层，第 4/5 层系统性；对照 MAINT-014 假绿先例） |
| 同类扫查有记录 | ✅ §6 |
| 修复方案 + 防护方案可实现 | ✅ §7（F1-F4，到函数/参数级）+ §8（a-d，含 TDD 判别组与快照校验） |
| mock 全绿未当真实链路证据 | ✅ §3 以真实宿主工件为准；§5-3/5-4 明确记入假绿机理 |
| 阶段 1 禁改产品代码 | ✅ 唯一写入 = 本报告 |
| 不创建子 agent / 不与用户交互 | ✅ |
