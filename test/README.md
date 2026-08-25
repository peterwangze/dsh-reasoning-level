# 回归测试（DEV-002 F8 + DEV-003 防护网补齐）

`node --test`（默认发现）或 `node --test "test/**/*.mjs"`。

> 已知差异：Node v24（Windows）下传目录字面量 `node --test test/` 会被当作 glob
> 模式处理且不匹配任何文件，runner 转而按模块入口执行而报 MODULE_NOT_FOUND；
> 改用默认发现（不带路径参数）或 glob 形式即可。
>
> **TDD 期望失败已转绿**（DEV-003 修复后 28/28 全绿）：N1 客户端超时常量已对齐服务端
> 最坏上界（95s）、N2 摘要状态随 probeAll 起始重置、gate-5（DEF-001 IPv6 回环）已按
> WHATWG URL 归一化修复；用例文件内的 `// TDD-GUARD-*`（原 `TDD-FAILS-UNTIL-*`）
> 标注保留为"修复守卫"语义——回归时失败即提示。

## 原理

插件遵循 DSH out-of-tree 契约：`dependencies` 恒为空，宿主包由 DSH 维护的
`$DSH_HOME/profiles/node_modules` 平坦回退树解析（插件自身零安装副作用），
仓库及父目录因此没有 node_modules。`resolve-fallback.mjs` 是 ESM 解析钩子：
标准解析失败时回退到该平坦树（`$DSH_HOME` 取 `~/.dsh`），使测试零安装即可
加载 `lib/index.js`。

`harness.mjs` 提供最小 stub ctx（settings 的 register/describe/get/mutate/replace、
llm 的 stream/resolveModelInfo、webServer.register 捕获、logger/effect/on/timeout），
调用真实 `apply(ctx)` 后向捕获的路由处理器投递模拟 req/res——与真实运行共用
`parseProbeInput -> probeModelLevels -> probeLevelOnce -> llm.stream ->
applyProbeResults` 全部执行路径；`ctx.on` 记录事件处理器，测试可驱动真实钩子
路径（MAINT-013 自愈黑名单仅内存态：真实调用拒绝 → 注入跳过 → 探测重置）。

## 覆盖（DEV-002 a-e + F1/F2 回归 + DEV-003 新增 + MAINT-013）

- `probe.test.mjs`（a）分类 ok/rejected=UNSUPPORTED/blocked=aborted；候选全量重测
  （不受黑名单过滤）；拒绝等级仅作为该次探测结果返回（不入黑名单、不持久化）；
- （b）用户手写声明跳过；working 白名单固化 + pin 持久化（含 'disabled' wire 值经 schema 校验）；
- （c）MAINT-013：持久化 probeBlacklist 兼容保留（boot 不装载，零数据破坏）；
  真实调用拒绝仅会话内存黑名单（注入跳过、零持久化）；/probe 起始重置该模型
  黑名单 → 注入恢复；探测拒绝不入黑名单；
- （d）F1 回归：probeEfforts 值 schema = string|null（接受 'disabled'/null，拒绝非字符串）；
- （e）F2 回归：replace 失败无 pin 分叉、成功时 replace 先于 probeEfforts 持久化；
- `gate-access.test.mjs` 403 门控：非回环 + statsPublic=false 拒绝（stats/probe/test/apply），
  statsPublic=true 放行，回环 Host 变体矩阵；
- `probe-errors.test.mjs` err 分支：no candidate levels / not-in-pi-ai-config /
  already-verified / 空 results / 空 body（400）/ /test 端点成功路径；
- `probe-timeout.test.mjs` 30s abort：中止定时器 30000ms 挂载 + 触发后 blocked 分类
  （不入黑名单；经 setTimeout 捕获与 signal 中止实现，不做真实等待）；
- `probe-concurrency.test.mjs` 并发：6 候选并发峰值 = PROBE_CONCURRENCY=3 + 混合分类矩阵；
- `schema-semantics.test.mjs` N4：显式 `z.union([z.string(), z.const(null)])` 与生产
  `z.string()` 行为等价（当前引擎 3.18.1）+ 超长（64KB）值边界；
- `client-meta-constants.test.mjs` **N1 TDD 守卫**：源码常量元测试——客户端抓取超时（95s）
  ≥ 服务端最坏波数×30s+5s（已转绿，回归即红）；
- `client-probe-summary.test.mjs` **N2 TDD 守卫**：probeAll 起始重置 probeSummaryOk、
  失败轮后重跑成功恢复绿色（已转绿，回归即红）；
- `resolve-fallback.test.mjs` T2：`$DSH_HOME` 优先（临时伪造树子进程集成）+ 回退
  ~/.dsh（单元 + 反向验证）。

## 依赖说明

- **本地开发**：零安装可跑——`resolve-fallback.mjs` 标准解析失败时回退到本机 DSH
  平坦回退树（`$DSH_HOME/profiles/node_modules`，缺省 `~/.dsh/...`）；仓库存在
  node_modules（npm install 后）时标准解析优先，回退树其次，语义不变。
- **CI**（T3，devDependencies 精确锁版供给）：devDependencies 锁版 import 链上的
  三包——`@deepseek-ai/schemastery@3.18.1`、`@deepseek-ai/dsh-settings@0.1.1-rc.2`
  与 `@deepseek-ai/cordis@4.0.1`（dsh-settings 模块级 import cordis，必须同装）；
  ci.yml 执行 `npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund`
  + `node --test`。**--legacy-peer-deps 处方与根因**：根项目 peerDependencies 全 `*`
  （运行时由 DSH 平坦回退树解析），测试仅需上述 import 链三包；npm≥7 的 peers
  自动安装会尝试补齐未在 lock 中的 peers（并可触发 `dsh-brand` 版本冲突），
  必须跳过——本地安装与 CI 命令同处方（本地已实证：不带 flag 的 `npm ci` 解析失败，
  带 flag 成功）。
  运行时契约不变：`dependencies` 仍为空、peers 仍全 `*`、发布物不含 node_modules。
