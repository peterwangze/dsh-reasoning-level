/**
 * 测试夹具（F8）：stub ctx 注入 + 通过真实 HTTP 路由处理器驱动。
 *
 * 原理：lib/index.js 的 apply(ctx) 把全部探测/固化逻辑装在闭包里，唯一可观察
 * 面是 webServer 注册的路由处理器与 settings/llm 桩。这里用最小 stub ctx
 * （内存版 SettingsForms 桩 + llm stream/resolveModelInfo + webServer register
 * 捕获 + logger/effect/on/timeout/inject 空实现）调用真实 apply，再向捕获的
 * 处理器投递模拟 req/res（EventEmitter + 捕获 writeHead/end），与真实运行
 * 完全同一执行路径（parseProbeInput -> probeModelLevels -> probeLevelOnce ->
 * llm.stream 等）。ctx.on 记录事件处理器（agent/request、agent/request-error、
 * llm/stream、settings/document-updated + 历史 settings/updated 候选），测试
 * 可驱动真实钩子路径（MAINT-013 自愈黑名单仅内存态验证）。
 *
 * MAINT-017 增强：settings.replace 更新 state.piAiSection 以支持临时声明
 * 机制的校验语义模拟；validatingStream 辅助函数提供符合真实 DSH 校验行为的
 * llm.stream 桩——在 effort 不在模型声明时抛出 UNSUPPORTED_REASONING_EFFORT。
 *
 * MAINT-035（0.2.0-rc.2）迁移：settings 桩改为 SettingsForms 形状——
 * describe() 返回描述符数组 [{ns, value, user, revision}]（value = defaults ∪
 * user 投影，等价旧 get 的 resolved 语义；user = 用户覆盖层，rawSection 消费）；
 * register/get 移除；update/replace/mutate 写 user 层 + bump revision；
 * configure 记录调用。ctx.inject(['settings'], cb) 同步触发（服务就绪即调，
 * cordis 4.0.5 语义），cb 收到的 child 携带 settings + effect。
 */
import { register } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 环境隔离（MAINT-035）：boot 迁移路径会读写 $DSH_HOME（settings.yaml.imported
// 读 + storages/reasoning-level-migrated.json 标记写）。测试进程缺省重定向到每
// 进程唯一临时目录，杜绝触碰真实 ~/.dsh（route-default-restart.test.mjs 先例；
// 文件自行设置 DSH_HOME 的不受影响——仅在未设置时兜底）。
if (process.env.DSH_HOME === undefined) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-rl-test-home-'))
}

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

/**
 * llm-reasoning 的缺省值投影基线（= Config schema 的 .default() 集；0.2.0
 * describe().value = defaults ∪ user）。与 lib/index.js 的 Config 声明同源——
 * settings-face-2.test.mjs 用 Config({}) resolve 输出锚定本表不漂移。
 */
export const RL_DEFAULTS = Object.freeze({
  enabled: true,
  level: 'high',
  models: {},
  syncDefaultAgent: false,
  purposes: {},
  statsPublic: false,
  probeBlacklist: {},
  probeEfforts: {},
})

/** 构造一个完整 stub ctx；options 覆盖桩行为。 */
export function makeCtx(options = {}) {
  const nsConfig = clone(options.nsConfig ?? { enabled: false, statsPublic: true })
  const piAiSection = clone(options.piAiSection)
  const state = {
    nsConfig,            // llm-reasoning user 层（replace 写入时同步更新）
    piAiSection,         // llm-pi-ai user 层（replace 时同步更新，供 validatingStream 读取当前声明）
    routes: new Map(),   // path -> handler
    schemas: new Map(),  // ns -> registered schema（历史面记录，0.2.0 起插件不再调用）
    replaceCalls: [],    // { ns, value }
    mutateCalls: [],     // { ns, ops }
    updateCalls: [],     // { ns, patch }（0.2.0 面——插件服务端暂不消费，面完整性保留）
    configureCalls: [],  // { presentation, owner }（0.2.0 configure 记录）
    injectCalls: [],     // [deps]（ctx.inject 调用记录）
    describeCalls: 0,    // describe() 调用计数（R0-P1-1 缓存判别测试观察面）
    events: [],          // 'replace:<ns>' / 'mutate:<ns>' 顺序记录（F2 断言）
    handlers: new Map(), // event -> callback（测试驱动钩子路径用）
  }
  const revisions = new Map([['llm-pi-ai', 0], ['llm-reasoning', 0], ['llm-deepseek', 0], ['agent-default-model', 0]])
  const bump = (ns) => revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
  // 内存版 SettingsForms 桩（0.2.0-rc.2 形状）：
  //  · describe() → 描述符数组（value 投影 / user 覆盖层 / revision 计数）
  //  · update/replace/mutate → 记录 + 写 user 层 + bump revision（piAi 的
  //    replaceImpl 失败语义保留——MAINT-017 收敛回滚测试依赖）
  //  · configure(presentation, owner) → 记录（返回 disposer）
  const builtInSettings = {
    configure(presentation, owner) {
      state.configureCalls.push({ presentation: clone(presentation), owner })
      return () => {}
    },
    describe() {
      state.describeCalls += 1
      return [
        { ns: 'llm-pi-ai', user: clone(state.piAiSection), value: state.piAiSection === undefined ? {} : clone(state.piAiSection), revision: revisions.get('llm-pi-ai') },
        { ns: 'llm-reasoning', user: clone(nsConfig), value: { ...RL_DEFAULTS, ...nsConfig }, revision: revisions.get('llm-reasoning') },
        { ns: 'llm-deepseek', user: undefined, value: undefined, revision: revisions.get('llm-deepseek') },
        { ns: 'agent-default-model', user: undefined, value: undefined, revision: revisions.get('agent-default-model') },
      ]
    },
    update(ns, patch) {
      state.updateCalls.push({ ns, patch: clone(patch) })
      state.events.push('update:' + ns)
      bump(ns)
      return Promise.resolve()
    },
    mutate(ns, ops) {
      state.mutateCalls.push({ ns, ops })
      state.events.push('mutate:' + ns)
      bump(ns)
      return Promise.resolve()
    },
    replace(ns, value) {
      state.replaceCalls.push({ ns, value })
      state.events.push('replace:' + ns)
      bump(ns)
      const promise = options.replaceImpl ? options.replaceImpl(ns, value) : undefined
      if (ns === 'llm-pi-ai') {
        // 仅在 replaceImpl 未抛出时更新 piAiSection（若抛出则保留原值）
        return Promise.resolve(promise).then(() => {
          state.piAiSection = clone(value)
        }).catch((error) => {
          state.replaceCalls.pop() // 移除失败记录
          state.events.pop()
          throw error
        })
      }
      if (ns === 'llm-reasoning') {
        return Promise.resolve(promise).then(() => {
          state.nsConfig = clone(value)
        })
      }
      return Promise.resolve(promise)
    },
  }
  const llm = {
    resolveModelInfo: options.resolveModelInfo ?? (async () => undefined),
    stream: options.stream ?? (async function* () {}),
  }
  // MAINT-036：settingsImpl 允许整体替换设置桩（契约自检负相——缺方法/缺 entry
  // 的旧宿主形态）；timeoutImpl 允许驱动 boot 重试链（缺省 no-op，既有测试语义
  // 不变——entry 缺席重试在缺省桩下不推进，负相测试显式注入同步实现）。
  const settings = options.settingsImpl ?? builtInSettings
  const webServer = {
    register({ kind, path, handler }) {
      state.routes.set(path, handler)
      return () => {}
    },
  }
  const ctx = {
    settings,
    llm,
    fiber: {}, // cordis fiber（configure(presentation, owner) 的 owner 参数面）
    logger: { warn() {}, info() {}, error() {} },
    get(key) {
      return key === 'webServer' ? webServer : undefined
    },
    effect(fn) {
      return fn()
    },
    on(eventName, callback) {
      /** 记录事件处理器（agent/request、agent/request-error、llm/stream、settings 候选名），测试驱动真实钩子路径。 */
      state.handlers.set(eventName, callback)
    },
    inject(dependencies, callback) {
      /** 同步触发注入回调（cordis 4.0.5：服务就绪即调）；deferInject=true 模拟
       * 极简 profile 无 settings 服务（回调永不触发——数据面自禁用负相）。
       * R0-P2-1：child.on 转接主 ctx.on（产品代码事件挂注入子 fiber；记录面
       * 仍进 state.handlers 供测试驱动）。 */
      state.injectCalls.push([...dependencies])
      if (options.deferInject === true) return undefined
      const child = { settings, effect: (fn, label) => ctx.effect(fn, label), on: (n, cb) => ctx.on(n, cb) }
      callback(child)
      return child
    },
    timeout(fn, ms) {
      if (options.timeoutImpl !== undefined) options.timeoutImpl(fn, ms)
    },
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

/** 向捕获的路由处理器投递模拟请求，返回 { code, payload }。
 *  host 可覆盖（403 门控测试需要非回环 Host）；text/plain 响应折叠为 { text }。 */
export async function callRoute(state, path, body, host = '127.0.0.1') {
  const handler = state.routes.get(path)
  if (handler === undefined) throw new Error('no route registered: ' + path)
  const req = new EventEmitter()
  req.headers = { host }
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
  let payload
  try {
    payload = JSON.parse(res.payload)
  } catch {
    payload = { text: res.payload } // 403 等 text/plain 响应
  }
  return { code: res.code, payload }
}

/** llm.stream 桩：按 reason 生成一个立即结束的 finish 流。 */
export function statusChunks(reason) {
  return async function* (options) {
    yield { type: 'finish', reason }
  }
}

/** llm.stream 桩：延迟 delayMs 后 yield finish，用于并发计数（onEnter/onExit 钩子跟踪在途数）。 */
export function latencyChunks(reason, delayMs = 5, onEnter, onExit) {
  return async function* () {
    onEnter?.()
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      yield { type: 'finish', reason }
    } finally {
      onExit?.()
    }
  }
}

export function blacklistMutates(state) {
  return state.mutateCalls.filter((c) => JSON.stringify(c.ops[0]?.path) === '["probeBlacklist"]')
}

export function probeEffortsMutates(state) {
  return state.mutateCalls.filter((c) => JSON.stringify(c.ops[0]?.path) === '["probeEfforts"]')
}

/** 读取 llm-pi-ai 中某模型的当前 reasoningEfforts（从 state.piAiSection 实时取）。 */
export function getModelReasoningEfforts(state, provider, model) {
  const piAi = state.piAiSection
  if (piAi === undefined) return undefined
  const profile = piAi.providers !== undefined ? piAi.providers[provider] : undefined
  if (profile === undefined || !Array.isArray(profile.models)) return undefined
  const entry = profile.models.find((m) => m.id === model)
  return entry !== undefined ? entry.reasoningEfforts : undefined
}

/** 筛选指定命名空间的 replace 调用。 */
export function replaceCallsFor(ns, state) {
  return state.replaceCalls.filter((c) => c.ns === ns)
}

/**
 * 创建模拟 DSH 校验行为的 llm.stream 桩：检查 reasoningEffort 是否在模型声明内，
 * 不在则抛出 UNSUPPORTED_REASONING_EFFORT（模拟 resolveCallWithInfo 本地校验）。
 * behaviors 映射 effort -> finish reason；缺省 behavior 的 effort 返回 { stop }。
 *
 * 用于 MAINT-017 临时声明机制测试——断言"声明外档不通过校验"的真实语义。
 *
 * stateOrGetter 可以是 state 对象，也可以是返回 state 的函数（用于 state 在
 * makeCtx 之后才可用的场景：先传递 getter，makeCtx 返回后赋值 state）。
 */
export function validatingStream(stateOrGetter, behaviors = {}) {
  const getState = typeof stateOrGetter === 'function' ? stateOrGetter : () => stateOrGetter
  return async function* (opts) {
    const state = getState()
    const effort = opts.reasoningEffort
    // 从 state.piAiSection 读取当前声明
    const decl = getModelReasoningEfforts(state, opts.provider, opts.model)
    const declLevels = decl !== undefined ? Object.keys(decl) : []
    if (effort !== undefined && declLevels.length > 0 && !declLevels.includes(effort)) {
      throw Object.assign(
        new Error(`reasoning effort "${effort}" is not supported by this model`),
        { code: 'UNSUPPORTED_REASONING_EFFORT' }
      )
    }
    const behavior = behaviors[effort]
    if (behavior !== undefined) {
      yield { type: 'finish', reason: behavior }
    } else {
      yield { type: 'finish', reason: { kind: 'stop', failure: null } }
    }
  }
}
