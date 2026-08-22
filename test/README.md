# 回归测试（DEV-002 F8）

`node --test`（默认发现）或 `node --test "test/**/*.mjs"`——两种形式均以 exit 0 通过。

> 已知差异：Node v24（Windows）下传目录字面量 `node --test test/` 会被当作 glob
> 模式处理且不匹配任何文件，runner 转而按模块入口执行而报 MODULE_NOT_FOUND；
> 改用默认发现（不带路径参数）或 glob 形式即可。

## 原理

插件遵循 DSH out-of-tree 契约：`dependencies` 恒为空，宿主包由 DSH 维护的
`$DSH_HOME/profiles/node_modules` 平坦回退树解析（插件自身零安装副作用），
仓库及父目录因此没有 node_modules。`resolve-fallback.mjs` 是 ESM 解析钩子：
标准解析失败时回退到该平坦树（`$DSH_HOME` 取 `~/.dsh`），使测试零安装即可
加载 `lib/index.js`。

`harness.mjs` 提供最小 stub ctx（settings 的 register/describe/get/mutate/replace、
llm 的 stream/resolveModelInfo、webServer.register 捕获、logger/effect/on/timeout），
调用真实 `apply(ctx)` 后向捕获的路由处理器投递模拟 req/res——与真实运行共用
`parseProbeInput -> probeModelLevels -> probeLevelOnce -> markRejected ->
persistBlacklist/hydrateBlacklist/applyProbeResults` 全部执行路径。

## 覆盖（对应 R0 报告 F8 建议 a-d + F2 回归）

- `probe.test.mjs`（a）分类 ok/rejected=UNSUPPORTED/blocked=aborted + 拒绝入黑名单持久化；
- （b）用户手写声明跳过；working 白名单固化 + pin 持久化（含 'disabled' wire 值经 schema 校验）；
- （c）hydrateBlacklist/persistBlacklist 幂等合并（去重、相同值不重复写）；
- （d）F1 回归：probeEfforts 值 schema = string|null（接受 'disabled'/null，拒绝非字符串）；
- （e）F2 回归：replace 失败无 pin 分叉、成功时 replace 先于 probeEfforts 持久化。

## 依赖说明

测试不修改 package.json、不安装任何依赖；加载的宿主包版本 = 本机 DSH 平坦回退树
（`~/.dsh/profiles/node_modules`）版本，与插件运行时契约一致。
