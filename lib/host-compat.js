/**
 * host-compat — DSH 宿主依赖单点契约模块（FEAT-001，设计
 * docs/host-compat/design-0.7.6.md §3.3，ADR DEC-018，方案 A）。
 *
 * 职责边界（BM-5 硬约束）：登记本插件对 DSH 宿主的全部契约性依赖
 * （事件名/服务名/命名空间/方法面/元数/信封形状），每条携带宿主出处；
 * 提供 settingsNamespace 跨版本接缝与 resolveDshHomeSafe 单源解析。
 * 供服务端代码（lib/index.js）、判别测试与 host-doctor 三方消费。
 * 不包含任何业务逻辑——导出面全部为 frozen 数据 + 上述两个函数。
 *
 * 准入标准：新增导出必须能回答「宿主出处 anchor 是什么」——答不出 = 不属
 * 此模块（BM-5：防上帝模块）；登记必须同步补 HOST_PROVENANCE 台账
 * （无出处的登记不许合入）。
 *
 * 客户端面（lib/client.js）不 import 本模块——宿主 makeRequire 的解析域只有
 * 平台 seed 词/已物化模块/已注册包工厂，无文件系统解析（dsh-client-modules
 * L300-310 实证，`require('./host-compat.js')` 必死）。客户端消费内嵌镜像段
 * （SINGLE-SOURCE-MIRROR，留在 client.js 工厂内——cordis 入口契约），由
 * test/host-compat-single-source.test.mjs 加载两平面真实工件 deep-equal 锚定
 * 一致；dsh 升级适配时本文件与镜像段必须同一变更单元同步修改。
 */
import * as dshSettings from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 事件名契约（S6）── 消费方：lib/index.js 四处 ctx.on ──────────────────────
export const HOST_EVENTS = Object.freeze({
  settingsUpdated: 'settings/updated',       // 出处：@deepseek-ai/dsh-settings lib/index.js L566（0.1.2-rc.1/0.1.5-rc.2 实证存续）
  agentRequest: 'agent/request',             // @deepseek-ai/dsh-agent-loop lib/index.js L1143（0.1.5-rc.2 实证存续）
  agentRequestError: 'agent/request-error',  // @deepseek-ai/dsh-agent-loop lib/index.js L1088（0.1.5-rc.2 实证存续）
  llmStream: 'llm/stream',                   // @deepseek-ai/dsh-llm lib/index.js L2307（0.1.5-rc.2 实证存续）
})

// ── 服务名/注入声明（S4）── 消费方：lib/index.js `export const inject = [...HOST_SERVICES.serverInject]`（拷贝）
export const HOST_SERVICES = Object.freeze({
  serverInject: Object.freeze(['settings', 'llm', 'timer']),  // cordis 服务名；timer=boot 重试
  webServer: 'webServer',                                      // 可选服务：ctx.get(HOST_SERVICES.webServer)
})

// ── 设置命名空间字符串（S5 配套）── 消费方：lib/index.js 16 处 settingsNamespace(...)
//    调用点收敛为 settingsNamespace(HOST_NAMESPACES.piAi) 等；字符串不再散落业务代码
export const HOST_NAMESPACES = Object.freeze({
  self: 'llm-reasoning', deepseek: 'llm-deepseek', piAi: 'llm-pi-ai', agentDefaultModel: 'agent-default-model',
})

// ── 服务方法名登记（S5/S7）── 登记+测试锚定用，不做逐调用点机械解引用（设计 §3.4 D2：
//    JS 属性访问无法被「导入收敛」，机械解引用增加噪声不改变漂移风险；真正看护在判别测试）
export const HOST_SETTINGS_METHODS = Object.freeze({
  register: 'register', get: 'get', describe: 'describe', replace: 'replace', mutate: 'mutate',
  mutateOps: Object.freeze(['set', 'unset']),  // ops 元素形状 {op:'set',path,value}|{op:'unset',path}
})
export const HOST_LLM_METHODS = Object.freeze({ resolveModelInfo: 'resolveModelInfo', stream: 'stream' })

/**
 * dsh-settings 命名空间品牌的跨版本接缝（S3，MAINT-021；自 lib/index.js L117-125 原样迁入，行为零变更）。
 *
 * 0.1.1-rc.2 公开导出 `settingsNamespace`（品牌化校验器）；0.1.2-rc.1 起
 * 该导出（连同 installSettingsSection / deepEqualJson）从公共面移除——命名
 * 空间改由 SettingsProvider 在 register/get/update/replace/mutate 入口内部
 * 解析校验。本插件 peers 声明为 `*`，必须同时运行在两代宿主上：
 * 优先取包内导出（旧宿主），缺席时回退到语义完全一致（正则、报错文案、
 * 返回原值均同源）的本地校验器（新宿主）。
 *
 * 为什么不用静态具名 import：具名 import 在导出缺席时是**模块加载期**
 * SyntaxError——插件行加载失败 → profile 挂载失败 → 整机 DSH 拉不起
 * （0.1.2-rc.1 升级实测，金丝雀 probe 复现 "does not provide an export
 * named 'settingsNamespace'"）。命名空间导入 + 运行时探测把断接缝从
 * 加载期推迟到可选路径，两代宿主均可加载。
 *
 * 签名：(value: string) => string；非法值 throw TypeError（与 0.1.1-rc.2 品牌
 * 校验器同源语义：正则、报错文案、返回原值；0.1.5-rc.2 逐字节核验仍一致）。
 * 本文件是全插件唯一 `import * as dshSettings` 点（设计 §3.4 D4——存根测试的
 * 模块重定向钩子按 specifier 拦截，import 点迁移不影响其工作）。
 */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/
const packageSettingsNamespace = typeof dshSettings.settingsNamespace === 'function' ? dshSettings.settingsNamespace : undefined
export const settingsNamespace = packageSettingsNamespace !== undefined
  ? packageSettingsNamespace
  : (value) => {
    if (!NAMESPACE_PATTERN.test(value)) {
      throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
    }
    return value
  }
/** 诊断面：settingsNamespace 当前生效路径（'package-export' | 'local-fallback'）——doctor/测试输出用。 */
export const settingsNamespaceOrigin = packageSettingsNamespace !== undefined ? 'package-export' : 'local-fallback'

/**
 * DSH home 单源解析（F-3 单源裁决，REVIEW-FEAT-001-R0：自 lib/index.js L51-60
 * 原样迁入并导出）。消费方：lib/index.js（boot 重试路径的统计持久化）、
 * scripts/host-doctor.mjs、判别测试——同源单点，杜绝 doctor 复制解析规则的
 * 第三份拷贝。
 *
 * 与 @deepseek-ai/dsh-home-paths 同源的解析规则，但零外部接缝：
 * $DSH_HOME 显式优先（空串视为未设置），缺省 ~/.dsh（~ 展开）。解析失败返回
 * undefined（统计持久化降级为内存态，宿主与请求路径完全不受影响）。
 */
export function resolveDshHomeSafe() {
  try {
    const env = typeof process !== 'undefined' && typeof process.env?.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : undefined
    return env !== undefined ? env : join(homedir(), '.dsh')
  } catch (error) {
    return undefined
  }
}

// ── 客户端面契约注册（C2/C3/C4；客户端代码不 import 本模块——client.js 内嵌镜像段消费）──
//    消费方：单源一致性测试（host-compat-single-source）、host-face-contract 判别测试、host-doctor
//    namespaces 字段（REVIEW-FEAT-001-R1 R-1 处置，设计 §3.3 镜像段范围扩展）：值 = HOST_NAMESPACES
//    的镜像数据——客户端 5 处功能性命名空间消费点（describe find ×3 + write-path RPC ns ×2）
//    改读镜像段同名子对象后，两平面 ns 一致性并入单源 deep-equal 域自动锚定。
export const HOST_REMOTE_CONTRACT = Object.freeze({
  faces: Object.freeze({ settings: 'remote.settings', session: 'remote.session' }),  // ctx.get('remote.'+name)
  clientInject: Object.freeze(['slots', 'locale', 'remote', 'remote.settings', 'remote.session']),
  namespaces: HOST_NAMESPACES,
  methods: Object.freeze({
    'settings.describe':    { arity: 0, params: [] },
    'settings.update':      { arity: 3, params: ['ns', 'patch', 'expectedRevision'], thirdParamAcceptsUndefined: true },
    'settings.mutate':      { arity: 3, params: ['ns', 'ops', 'expectedRevision'], thirdParamAcceptsUndefined: true, opShapes: ['set', 'unset'] },
    'session.modelCatalog': { arity: 0, params: [] },
  }),
  responseEnvelope: 'direct:{ok,value|error}',   // 宿主 typed remote 直面；适配层收敛为旧信封 {result:{ok,value|error}}
  legacyEnvelope: '{result:{ok,value|error}}',   // 页面消费面（保持不变——MAINT-022「页面零改动」语义）
})

// ── 出处台账（设计 §2 实证清单的数据源；doctor 与断言输出消费；人机共读）──
//    每条 { touchpoint, package, verified, anchor }；verified = 已人工核对的工作宿主版本
//    （仅列设计文档实证过的版本，未验证不写）。C5/S8 按 D6 显式豁免出契约常量（fail-soft/
//    属性访问面），台账在册以保持 §2 全触点可追溯。
export const HOST_PROVENANCE = Object.freeze([
  { touchpoint: 'S1 schemastery 默认导出+使用面（z.object/union/dict/boolean/const/string/array）', package: '@deepseek-ai/schemastery', verified: ['3.18.1', '3.18.2'], anchor: '公开导出面（3.18.1↔3.18.2 lib 逐字节一致，MAINT-029 核对；消费点在 lib/index.js——D3 保留直连不入本模块常量）' },
  { touchpoint: 'S2 命名空间导入 @deepseek-ai/dsh-settings', package: '@deepseek-ai/dsh-settings', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: '包公开导出面（命名空间导入跨代安全；0.1.2-rc.1 起 settingsNamespace 导出移除——MAINT-021）' },
  { touchpoint: 'S3 settingsNamespace 跨版本接缝（包内导出优先+本地同源回退）', package: '@deepseek-ai/dsh-settings', verified: ['0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.2'], anchor: '内部函数 parseSettingsNamespace（SettingsProvider 入口内部解析；本地回退与之逐字节同源，0.1.5-rc.2 核验一致）' },
  { touchpoint: 'S4 服务端 inject 服务名（settings/llm/timer）', package: '@deepseek-ai/cordis（容器）+ dsh-settings/dsh-llm（服务）', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'cordis 服务注入面（timer 供 boot 重试；HOST_SERVICES.serverInject/webServer）' },
  { touchpoint: 'S5 settings 服务方法面 register/get/describe/replace/mutate + mutate ops 形状', package: '@deepseek-ai/dsh-settings', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'SettingsProvider 方法面（mutate ops 元素 {op:"set"|"unset",path,value}；HOST_SETTINGS_METHODS 登记，D2 不做逐调用点解引用）' },
  { touchpoint: 'S6 事件名 settings/updated', package: '@deepseek-ai/dsh-settings', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'lib/index.js L566（HOST_EVENTS.settingsUpdated）' },
  { touchpoint: 'S6 事件名 agent/request', package: '@deepseek-ai/dsh-agent-loop', verified: ['0.1.5-rc.2'], anchor: 'lib/index.js L1143（HOST_EVENTS.agentRequest）' },
  { touchpoint: 'S6 事件名 agent/request-error', package: '@deepseek-ai/dsh-agent-loop', verified: ['0.1.5-rc.2'], anchor: 'lib/index.js L1088（HOST_EVENTS.agentRequestError）' },
  { touchpoint: 'S6 事件名 llm/stream', package: '@deepseek-ai/dsh-llm', verified: ['0.1.5-rc.2'], anchor: 'lib/index.js L2307（HOST_EVENTS.llmStream）' },
  { touchpoint: 'S7 llm.resolveModelInfo(provider, model) + llm.stream(options)', package: '@deepseek-ai/dsh-llm', verified: ['0.1.5-rc.2'], anchor: 'llm 服务面（HOST_LLM_METHODS 登记，D2 不做逐调用点解引用）' },
  { touchpoint: 'S8 agent/request payload reasoningEffort 字段名', package: '@deepseek-ai/dsh-agent-loop', verified: ['0.1.5-rc.2'], anchor: 'lib/index.js L1136-1140/L1497 payload schema（D6 显式豁免出注册表——判别测试条目 6 T 级锚串看护）' },
  { touchpoint: 'S9 dsh-llm effort 校验结构（临时声明机制存在前提）', package: '@deepseek-ai/dsh-llm', verified: ['0.1.5-rc.2'], anchor: 'resolveCallWithInfo L2111-2127 effort 校验段（MAINT-014/017 事故关联触点）' },
  { touchpoint: 'S10 webServer 服务获取 + register({kind:"exact",path,handler})', package: '@deepseek-ai/dsh-host-webserver', verified: ['0.1.5-rc.2'], anchor: 'L176-178 路由注册面（HOST_SERVICES.webServer；注册失败已有降级）' },
  { touchpoint: 'S11 cordis Context 面（on/effect/timeout/logger/get）', package: '@deepseek-ai/cordis', verified: ['4.0.1', '4.0.2'], anchor: '框架核心 Context 面（4.0.1↔4.0.2 lib 逐字节一致，MAINT-029；D5 接受为平台基线不入契约表）' },
  { touchpoint: 'C1 客户端 bundle 形态契约（__ModuleLoader__.load 工厂 CJS，唯一 require=react）', package: '@deepseek-ai/dsh-client-modules', verified: ['0.1.5-rc.2'], anchor: 'makeRequire L300-310（解析域仅平台 seed/已物化/已注册包工厂，miss 即 throw 无文件系统解析）+ materialize L271-293；单源测试断言 require 集 === ["react"]' },
  { touchpoint: 'C2 客户端 inject 命名空间（slots/locale/remote/remote.settings/remote.session）', package: '@deepseek-ai/dsh-api-remotes + dsh-client-locale + dsh-client-ui（slots）', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'runner 激活门控命名空间面（先例 dsh-client-ui-settings-models 静态 inject；HOST_REMOTE_CONTRACT.clientInject）' },
  { touchpoint: 'C3 hostApiFace 适配层（remote face 惰性解析+信封收敛+缺失 fail-loud）', package: '@deepseek-ai/dsh-api-remotes', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'typed remote 直面形状（HOST_REMOTE_CONTRACT.responseEnvelope/legacyEnvelope；适配逻辑在 lib/client.js——非本模块职责）' },
  { touchpoint: 'C4 remote.settings/session 方法集与元数（describe(0)/update(3)/mutate(3)/modelCatalog(0)）', package: '@deepseek-ai/dsh-api-remotes', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'settings/session 描述符（MAINT-025 根因触点；HOST_REMOTE_CONTRACT.methods 元数表，第三参 expectedRevision 显式占位语义）' },
  { touchpoint: 'C5 locale 快照 + slots 注册（settings.section list slot order/label）', package: '@deepseek-ai/dsh-client-locale + dsh-client-ui（slots）', verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'locale.getSnapshot().active（回退 zh）+ ctx.slots.inject/register（D6 显式豁免出注册表——fail-soft 单点消费面，client-smoke 桩级守护）' },
  { touchpoint: 'C6 package.json dsh.client.inject 声明名单（三名）', package: '@deepseek-ai/dsh-client-modules', verified: ['0.1.5-rc.2'], anchor: 'boot graph arriveGraphRow L265-268（未知名静默跳过）+ resolveMeta/clientExportOf L637-667（单 client 工件通道；死声明 dsh-client-runtime 已于 910baed 清理，MAINT-029）' },
  { touchpoint: 'C7 stats 端点直连 fetch + window.setInterval/clearInterval', package: '（自有面——自注册路由，非宿主 API）', verified: [], anchor: 'dsh-host-webserver 挂载面上的自有路由 /reasoning-level-stats*（不依赖宿主 API 形状，低风险）' },
])
