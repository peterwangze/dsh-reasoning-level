/**
 * 持久化存储型 stub ctx（MAINT-027/028 判别测试专用，RCA §5）。
 *
 * 与 harness.mjs 的 makeCtx 差异（判别点）：settings.get/describe/replace/mutate
 * 全部读写同一个 **live store 对象**——mutate 就地应用 set/unset 嵌套路径 ops、
 * replace 整节替换。这样「重启」可以按 RCA P2 证明场景精确模拟：
 * `makeStoreCtx(store)` 再次调用 → 新 ctx（插件闭包内存台账清空）+ 同一 store
 * （settings.yaml 持久面）→ mount → 观察插件能否凭持久面恢复所有权/回显。
 *
 * state 形状与 harness.mjs 保持兼容（routes/replaceCalls/mutateCalls/events/
 * handlers/schemas/piAiSection）——callRoute/validatingStream/probeEffortsMutates/
 * getModelReasoningEfforts 等既有夹具直接可用。
 */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/** 就地应用 settings.mutate ops（set/unset，嵌套路径）——dsh-settings 服务端面语义。 */
export function applyOpsTo(target, ops) {
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op === null || typeof op !== 'object' || !Array.isArray(op.path)) continue
    let cursor = target
    for (let i = 0; i < op.path.length - 1; i++) {
      const key = op.path[i]
      if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
      cursor = cursor[key]
    }
    const last = op.path[op.path.length - 1]
    if (op.op === 'set') cursor[last] = op.value
    else if (op.op === 'unset') delete cursor[last]
  }
}

/**
 * 构造读写同一 live store 的 stub ctx。
 * store: { nsConfig: {...llm-reasoning 节}, piAi: {...llm-pi-ai 节} | undefined,
 *         deepseek: {...llm-deepseek 节} | undefined }
 * options: { stream?, resolveModelInfo? } —— 同 harness.makeCtx。
 */
export function makeStoreCtx(store, options = {}) {
  const state = {
    piAiSection: store.piAi, // 供 validatingStream/getModelReasoningEfforts 读取（replace 后同步）
    routes: new Map(),
    schemas: new Map(),
    replaceCalls: [],
    mutateCalls: [],
    events: [],
    handlers: new Map(),
  }
  const settings = {
    register(ns, schema) {
      state.schemas.set(ns, schema)
    },
    describe() {
      return [
        { ns: 'llm-pi-ai', user: clone(store.piAi) },
        { ns: 'llm-reasoning', user: clone(store.nsConfig) },
        { ns: 'llm-deepseek', user: clone(store.deepseek) },
        { ns: 'agent-default-model', user: undefined },
      ]
    },
    get(ns) {
      if (ns === 'llm-reasoning') return store.nsConfig
      if (ns === 'llm-pi-ai') return store.piAi ?? {}
      if (ns === 'llm-deepseek') return store.deepseek
      return undefined
    },
    mutate(ns, ops) {
      state.mutateCalls.push({ ns, ops })
      state.events.push('mutate:' + ns)
      if (ns === 'llm-reasoning') applyOpsTo(store.nsConfig, ops)
      else if (ns === 'llm-deepseek' && store.deepseek !== undefined) applyOpsTo(store.deepseek, ops)
      return Promise.resolve()
    },
    replace(ns, value) {
      state.replaceCalls.push({ ns, value })
      state.events.push('replace:' + ns)
      if (ns === 'llm-pi-ai') {
        store.piAi = clone(value)
        state.piAiSection = store.piAi
      }
      return Promise.resolve()
    },
  }
  const llm = {
    resolveModelInfo: options.resolveModelInfo ?? (async () => undefined),
    stream: options.stream ?? (async function* () {}),
  }
  const webServer = {
    register({ kind, path, handler }) {
      state.routes.set(path, handler)
      return () => {}
    },
  }
  const ctx = {
    settings,
    llm,
    logger: { warn() {}, info() {}, error() {} },
    get(key) {
      return key === 'webServer' ? webServer : undefined
    },
    effect(fn) {
      return fn()
    },
    on(eventName, callback) {
      state.handlers.set(eventName, callback)
    },
    timeout() {},
  }
  return { ctx, state }
}

/** llm-reasoning.lastProbe 的 set 持久化调用（027-F3 断言用）。 */
export function lastProbeMutates(state) {
  return state.mutateCalls.filter((c) => c.ns === 'llm-reasoning' && Array.isArray(c.ops)
    && c.ops[0] !== undefined && c.ops[0].op === 'set' && Array.isArray(c.ops[0].path)
    && c.ops[0].path[0] === 'lastProbe')
}

/** llm-reasoning.applied 的 set 持久化调用（028-F1 断言用）。 */
export function appliedMutates(state) {
  return state.mutateCalls.filter((c) => c.ns === 'llm-reasoning' && Array.isArray(c.ops)
    && c.ops[0] !== undefined && c.ops[0].op === 'set' && Array.isArray(c.ops[0].path)
    && c.ops[0].path[0] === 'applied')
}
