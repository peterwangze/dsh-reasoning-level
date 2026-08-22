/**
 * 测试夹具（F8）：stub ctx 注入 + 通过真实 HTTP 路由处理器驱动。
 *
 * 原理：lib/index.js 的 apply(ctx) 把全部探测/固化逻辑装在闭包里，唯一可观察
 * 面是 webServer 注册的路由处理器与 settings/llm 桩。这里用最小 stub ctx
 * （settings description/get/mutate/replace + llm stream/resolveModelInfo +
 * webServer register 捕获 + logger/effect/on/timeout 空实现）调用真实 apply，
 * 再向捕获的处理器投递模拟 req/res（EventEmitter + 捕获 writeHead/end），
 * 与真实运行完全同一执行路径（parseProbeInput -> probeModelLevels ->
 * probeLevelOnce -> llm.stream -> markRejected -> persistBlacklist 等）。
 */
import { register } from 'node:module'
import { EventEmitter } from 'node:events'

let pluginPromise = null

/** 注册 ESM 回退钩子并动态加载插件模块（每个测试进程执行一次）。 */
export function loadPlugin() {
  if (pluginPromise === null) {
    register(new URL('./resolve-fallback.mjs', import.meta.url).href)
    pluginPromise = import('../lib/index.js').catch((error) => {
      pluginPromise = null
      throw error
    })
  }
  return pluginPromise
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/** 构造一个完整 stub ctx；options 覆盖桩行为。 */
export function makeCtx(options = {}) {
  const nsConfig = clone(options.nsConfig ?? { enabled: false, statsPublic: true })
  const piAiSection = clone(options.piAiSection)
  const state = {
    nsConfig,
    piAiSection,
    routes: new Map(), // path -> handler
    schemas: new Map(), // ns -> registered schema
    replaceCalls: [], // { ns, value }
    mutateCalls: [], // { ns, ops }
    events: [], // 'replace:<ns>' / 'mutate:<ns>' 顺序记录（F2 断言）
  }
  const settings = {
    register(ns, schema) {
      state.schemas.set(ns, schema)
    },
    describe() {
      return [
        { ns: 'llm-pi-ai', user: clone(piAiSection) },
        { ns: 'llm-reasoning', user: clone(nsConfig) },
        { ns: 'llm-deepseek', user: undefined },
        { ns: 'agent-default-model', user: undefined },
      ]
    },
    get(ns) {
      if (ns === 'llm-reasoning') return nsConfig
      if (ns === 'llm-pi-ai') return piAiSection ?? {}
      return undefined
    },
    mutate(ns, ops) {
      state.mutateCalls.push({ ns, ops })
      state.events.push('mutate:' + ns)
      return Promise.resolve()
    },
    replace(ns, value) {
      state.replaceCalls.push({ ns, value })
      state.events.push('replace:' + ns)
      return Promise.resolve(options.replaceImpl ? options.replaceImpl(ns, value) : undefined)
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
      /** 事件监听仅在插件内部使用；测试不驱动事件，槽位保留为 no-op。 */
    },
    timeout() {},
  }
  return { ctx, state }
}

/** apply + 等待 boot/applyLevel 的异步链落定。 */
export async function mount(ctx) {
  const mod = await loadPlugin()
  mod.apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** 向捕获的路由处理器投递模拟请求，返回 { code, payload }。 */
export async function callRoute(state, path, body) {
  const handler = state.routes.get(path)
  if (handler === undefined) throw new Error('no route registered: ' + path)
  const req = new EventEmitter()
  req.headers = { host: '127.0.0.1' }
  const res = {
    writeHead(code, hdrs) {
      this.code = code
      this.hdrs = hdrs
    },
    end(payload) {
      this.payload = payload
      if (this._resolve) this._resolve()
    },
  }
  const done = new Promise((resolve) => {
    res._resolve = resolve
  })
  handler(req, res)
  req.emit('data', typeof body === 'string' ? body : JSON.stringify(body ?? {}))
  req.emit('end')
  await done
  return { code: res.code, payload: JSON.parse(res.payload) }
}

/** llm.stream 桩：按 reason 生成一个立即结束的 finish 流。 */
export function statusChunks(reason) {
  return async function* (options) {
    yield { type: 'finish', reason }
  }
}

export function blacklistMutates(state) {
  return state.mutateCalls.filter((c) => JSON.stringify(c.ops[0]?.path) === '["probeBlacklist"]')
}

export function probeEffortsMutates(state) {
  return state.mutateCalls.filter((c) => JSON.stringify(c.ops[0]?.path) === '["probeEfforts"]')
}
