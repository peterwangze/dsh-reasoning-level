/**
 * MAINT-025 判别测试（真实工件判别——禁止桩对桩自证）+ FEAT-002 双工件源泛化。
 *
 * 背景（docs/retro/rca-MAINT-025.md）：MAINT-022 的 hostApiFace 适配层把
 * remote.settings.update/mutate 按 2 个位置参数转发（lib/client.js:910/914），
 * 宿主 0.1.2-rc.1 描述符要求 3 参（ns, patch/ops, expectedRevision），客户端
 * 网关在 RPC 前执行严格元数守卫（dsh-api-gateway lib/client.js:1626-1633）
 * → 每次设置写入确定性 throw，被 change() catch 吞成「保存失败」。
 * 47/47 全绿未拦住本缺陷的直接原因：旧测试/冒烟的 remote 桩是普通 JS 函数，
 * 不校验元数，且桩形状抄自适配层自身假设（桩 ↔ 适配层循环自证，RCA 5-Why
 * 第 3 层）。本判别测试改用**真实宿主工件**：
 *
 *   Half A（宿主侧）：vm 加载真实 dsh-api-remotes bundle，经真实 apply() →
 *           ctx.remote.$mount 捕获全部真实 contribution，提取目标方法的
 *           **真实描述符元数**；
 *   Half B（插件侧）：加载真实插件 lib/client.js，捕获适配层对每个方法的
 *           **实传参数量**（记录型 fake remote 用 rest 参数捕获 arguments）；
 *   断言：逐方法 实传元数 === 真实描述符 parameters.length + 实传形状；
 *   守卫对照：用真实描述符 + 逐字复制的 gateway 元数守卫驱动正反例——
 *           2 参写调用必被拒（负对照）、3 参含显式 undefined 必放行（正对照）。
 *
 * FEAT-002 泛化（设计 §4，DEC-018 ③④）：断言清单 §4.2 十一条探针化到
 * test/host-probes.mjs（测试与 doctor 共用，判据零分叉），本文件是 node:test
 * 外壳。双工件源：
 *   工件源① baseline = 仓库 node_modules devDeps 精确锁版（含 0.1.2-rc.1 的
 *             dsh-agent-loop/dsh-llm/dsh-host-webserver——A-2 已验证可安装），
 *             CI 恒断言 fail-closed（包缺席/版本失配即 throw，沿用本文件历史语义）；
 *   工件源② live = DSH_HOST_TREE（profiles 目录或其 node_modules；旧名
 *             DSH_HOST_PACKAGES 保留为别名——语义并入：指向活树而非基线覆盖）。
 *             在场即对活树执行同一套探针；缺席即逐条**显式 SKIP 带原因**
 *             （断言 skip 行为本身——不用 node:test 的 t.skip，测试计数恒 0 skipped，
 *             显式性由断言承担，不静默不假绿）。
 *   T 级失败分级（BM-2）：baseline=FAIL / live=DRIFT（探针模块内实现）。
 * 历史锚 EXPECTED_HOST_VERSION/npx 缓存解析链已移除——基线版本锚=package.json
 * devDependencies（探针 requirePackage 校验已安装版本 === 锁版）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import {
  baselineSource, liveSourceFromEnv, requirePackage, runEntry, runBattery,
  loadApiRemotesContributions, descriptorOf, descriptorIdOf, checkArityTable,
  mirrorMatches, PROBES,
} from './host-probes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const baseline = baselineSource()
const live = liveSourceFromEnv()
const hostTreeProbes = PROBES.filter((p) => p.requiresHostTree)
const ownProbes = PROBES.filter((p) => !p.requiresHostTree)

const fmt = (r) => `  #${r.id} [${r.status}]${r.skip ? `(${r.skip})` : ''} ${r.touchpoint}\n      ${r.status === 'PASS' ? r.evidence : (r.skipReason ?? r.evidence)}${r.hint ? `\n      ↳ ${r.hint}` : ''}`

// ── 工件源①：devDeps 锁版基线全量断言（CI 恒跑 fail-closed）────────────────
test('(FEAT-002/§4.2 条目1-7,10) 工件源① devDeps 基线：全部宿主树探针必须 PASS（包缺席/版本失配即 throw）— // TDD-GUARD-MAINT-025', async () => {
  const results = []
  for (const probe of hostTreeProbes) results.push(await runEntry(probe, baseline))
  const bad = results.filter((r) => r.status !== 'PASS')
  assert.equal(bad.length, 0, `工件源①（${baseline.label}）基线断言必须全 PASS——锁版工件不该漂，任何 FAIL 都意味着锁版被动过或宿主 artifact 异常：\n${results.map(fmt).join('\n')}`)
})

// ── 自有工件探针（条目 8/9/11）：零环境依赖恒跑（BM-4：不允许环境条件 skip）──
test('(FEAT-002/§4.2 条目8,9,11) 自有工件探针恒跑恒断言（无源依赖）', async () => {
  const results = []
  for (const probe of ownProbes) results.push(await runEntry(probe, null))
  const bad = results.filter((r) => r.status !== 'PASS')
  assert.equal(bad.length, 0, `自有工件探针（C1 形态 / 镜像单源 / fail-loud）必须恒 PASS：\n${results.map(fmt).join('\n')}`)
})

// ── 工件源②：活树（在场即断言；缺席即逐条显式 SKIP 带原因——不静默不假绿）──
test('(FEAT-002/§4.1) 工件源②活树行为：缺席 → 逐条显式 SKIP 带原因（断言 skip 行为本身，测试计数不产生 skipped）；在场 → 全 PASS（T 级 DRIFT 容忍）', async () => {
  const results = []
  for (const probe of hostTreeProbes) results.push(await runEntry(probe, live))
  if (live === null) {
    // 缺席分支：每条必须显式 SKIP（LIVE-TREE-ABSENT）且携带原因与提示——
    // 静默通过（PASS/未执行）= 假绿，此断言红。
    for (const r of results) {
      assert.equal(r.status, 'SKIP', `活树缺席时条目 #${r.id} 必须 SKIP（实得 ${r.status}）——显式 skip 是设计行为`)
      assert.equal(r.skip, 'LIVE-TREE-ABSENT', `条目 #${r.id} skip 类别必须标明 LIVE-TREE-ABSENT`)
      assert.ok(r.skipReason && r.skipReason.includes('DSH_HOST_TREE'), `条目 #${r.id} skip 必须带原因（指明如何启用）`)
    }
    assert.ok(results.length >= 8, `宿主树探针应 ≥8 条（实得 ${results.length}）`)
    return
  }
  // 在场分支：双源验证门禁——FAIL / SKIP-UNRESOLVED 均红（SKIP 说明树不完整，
  // 对「验证与该树兼容」这一目标而言就是失败——BM-3 的宽容归因属 doctor 职责，
  // 测试门禁要求指向完整树）；T 级 DRIFT 允许（BM-2：人工复核 SOP，doctor 醒目输出）。
  for (const r of results) {
    assert.notEqual(r.status, 'FAIL', `活树断言 FAIL：\n${fmt(r)}`)
    assert.notEqual(r.status, 'SKIP', `活树断言 SKIP（树不完整或布局漂移——BM-3）：\n${fmt(r)}`)
    if (r.status === 'DRIFT') assert.equal(r.level, 'T', `仅 T 级允许 DRIFT（B 级行为断裂必须 FAIL）：\n${fmt(r)}`)
  }
})

// ── MAINT-025 判别核心（Half A/B）——参数化到可用工件源 ─────────────────────
// 判别目标：适配层消费的全部 4 个数据面方法（RCA §1/#12/#13 + §6——泛化到
// 整类元数断裂）。id 派生自 HOST_REMOTE_CONTRACT.methods（单一清单）。
const TARGET_METHODS = Object.keys((await import('../lib/host-compat.js')).HOST_REMOTE_CONTRACT.methods)

// Half B：加载真实插件 client.js，记录型 fake remote 捕获实传元数
// （vm dual-face 加载器与 test/client-host-face-compat.test.mjs 同构）。
const DESCRIBE_VALUE = {
  writable: true,
  hasDocument: true,
  namespaces: [
    { ns: 'llm-reasoning', schema: null, value: { enabled: true, level: 'high', models: { 'demo/m1': 'low' }, purposes: {}, syncDefaultAgent: false, statsPublic: false }, applies: 'live', secrets: [], revision: 1 },
  ],
}
const CATALOG_VALUE = {
  default: { provider: 'demo', model: 'm1', reasoningEffort: 'high' },
  routableProviders: ['demo'],
  groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] }],
}

const react = {
  createElement(tag, props, ...children) {
    return { $$: typeof tag === 'function' ? 'component' : String(tag), tag, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useRef(initial) { return { ref: { current: initial } } },
}

// 记录型 fake remote：rest 参数捕获实传 argument 个数与值（普通具名参数桩
// 无法暴露元数违约——MAINT-025 假绿机理，RCA 5-Why 第 3 层）。
function recordingRemoteFaces(calls) {
  return {
    remoteSettings: {
      describe: async (...args) => { calls.push(['settings.describe', args.length, ...args]); return { ok: true, value: DESCRIBE_VALUE } },
      update: async (...args) => { calls.push(['settings.update', args.length, ...args]); return { ok: true, value: { ns: args[0], value: {} } } },
      mutate: async (...args) => { calls.push(['settings.mutate', args.length, ...args]); return { ok: true, value: { ns: args[0], value: {} } } },
    },
    remoteSession: {
      modelCatalog: async (...args) => { calls.push(['session.modelCatalog', args.length]); return { ok: true, value: CATALOG_VALUE } },
    },
  }
}

function loadPluginAdapter(calls) {
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { loaded = def } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ since: Date.now(), totalCalls: 0, models: {}, recent: [], blacklist: {} }) }),
    AbortController,
  }
  vm.runInNewContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
  assert.ok(loaded && loaded.id === 'dsh-reasoning-level', 'plugin client module must load')
  const client = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('client required unexpected module: ' + name)
  })
  const faces = recordingRemoteFaces(calls)
  const registered = []
  client.apply({
    get: (name) => (name === 'remote.settings' ? faces.remoteSettings
      : name === 'remote.session' ? faces.remoteSession
      : name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject: (_slot, provider) => provider(),
      register: (meta, render) => { registered.push({ meta, render }); return () => {} },
    },
  })
  assert.equal(registered.length, 1, 'apply 必须注册唯一 settings.section')
  const api = registered[0].render({}).props.api
  assert.ok(api && api.settings && api.llm, 'section element 必须携带适配层 api')
  return api
}

// 以页面真实调用形状驱动适配层全部 4 个数据面方法（change() 调用形状锚定
// lib/client.js:766-772——页面不传 expectedRevision，由适配层补第三参占位）。
async function driveAdapter(api) {
  await api.settings.describe({})
  await api.settings.update({ ns: 'llm-reasoning', patch: { level: 'medium' } })
  await api.settings.mutate({ ns: 'llm-reasoning', ops: [{ op: 'unset', path: ['models', 'demo/m1'] }] })
  await api.llm.models()
}

// ── 判别核心（对每个可用工件源执行：基线恒跑；活树在场即跑）─────────────────
const discriminatingSources = [baseline]
if (live !== null) discriminatingSources.push(live)

for (const source of discriminatingSources) {
  test(`(MAINT-025) 判别核心〔${source.label}〕：适配层实传元数 === 真实描述符元数（describe/update/mutate/modelCatalog 逐方法 + 实传形状）— // TDD-GUARD-MAINT-025`, async () => {
    const pkg = requirePackage(source, 'dsh-api-remotes')
    const { contributions, disposer } = await loadApiRemotesContributions(pkg.dir)
    try {
      const calls = []
      await driveAdapter(loadPluginAdapter(calls))

      const rows = TARGET_METHODS.map((key) => {
        const id = descriptorIdOf(key)
        const descriptor = descriptorOf(contributions, id)
        assert.ok(descriptor, `真实 bundle 必须含 ${id} 描述符`)
        const call = calls.find((entry) => entry[0] === key)
        assert.ok(call, `适配层必须调用 ${key}（判别驱动覆盖缺失）`)
        return { key, id, descriptor, forwardedCount: call[1], forwardedArgs: call.slice(2) }
      })

      const table = rows.map(({ key, descriptor, forwardedCount }) =>
        `  ${key.padEnd(20)} forwarded=${forwardedCount} descriptor=${descriptor.parameters.length}${forwardedCount === descriptor.parameters.length ? '' : '  ← MISMATCH'}`,
      ).join('\n')

      // 元数判别（RED→GREEN 翻转点：修复前 update/mutate 行为 MISMATCH）
      for (const { key, id, descriptor, forwardedCount } of rows) {
        assert.equal(
          forwardedCount, descriptor.parameters.length,
          `${key} 元数断裂：适配层实传 ${forwardedCount} 参，真实描述符 ${descriptor.parameters.length} 参（${id}）。\n` +
          `宿主网关元数守卫（dsh-api-gateway lib/client.js:1626-1633）在 RPC 前即 throw——即「保存失败」根因。\n全部方法比对：\n${table}`,
        )
      }

      // 实传形状判别（RCA §8-a-4）
      const describe = rows[0]
      const update = rows[1]
      const mutate = rows[2]
      const modelCatalog = rows[3]
      assert.equal(typeof update.forwardedArgs[0], 'string', 'update 第一参 ns 必须是 string（描述符 mutate:ns=string，api-remotes:4758 同族）')
      assert.equal(update.forwardedArgs[0], 'llm-reasoning', 'update ns 必须是 llm-reasoning')
      assert.ok(update.forwardedArgs[1] && typeof update.forwardedArgs[1] === 'object' && !Array.isArray(update.forwardedArgs[1]), 'update 第二参 patch 必须是普通对象')
      assert.equal(mutate.forwardedArgs[0], 'llm-reasoning', 'mutate ns 必须是 llm-reasoning')
      assert.ok(Array.isArray(mutate.forwardedArgs[1]), 'mutate 第二参 ops 必须是数组')
      assert.deepEqual(
        JSON.parse(JSON.stringify(mutate.forwardedArgs[1])),
        [{ op: 'unset', path: ['models', 'demo/m1'] }],
        'mutate ops 形状锚定 api-remotes:4759-4774（op:set{path,value}/op:unset{path}）',
      )
      // 写路径第三参显式占位（rest 参数长度 3 = 显式传了 undefined；透传省略 =
      // 2 参 = 本缺陷本体。值可 undefined——宿主语义 "undefined writes
      // unconditionally"（dsh-api-settings-controller lib/index.js:443/454/467）。
      for (const { key, forwardedArgs } of [update, mutate]) {
        assert.equal(forwardedArgs.length, 3, `${key} 第三参 expectedRevision 必须显式占位（.d.ts number|undefined 非 optional，必须传位；值可 undefined）`)
        assert.ok(forwardedArgs[2] === undefined || (Number.isInteger(forwardedArgs[2]) && forwardedArgs[2] >= 0), `${key} 第三参必须是 undefined 或非负 revision`)
      }
      assert.equal(describe.forwardedCount, 0, 'describe 读路径零参（渲染正常的机理——元数恰配）')
      assert.equal(modelCatalog.forwardedCount, 0, 'modelCatalog 读路径零参')
    } finally {
      await disposer()
    }
  })
}

// ── 逐字复制 dsh-api-gateway lib/client.js:1626-1633（prepareInvocation 元数
// 守卫段）。唯一替换：endpointOf(descriptor) → descriptor.id（直调用面
// endpoint 即 descriptor.id——RCA §3 Half A 同款消息保真替换）；直调用时
// projection 恒 undefined。禁止"改写收敛"——守卫逐字保真才具备判别力。
function gatewayArityGuard(descriptor, values) {
  const endpoint = descriptor.id
  const projection = void 0
  const expected = descriptor.parameters.length - (projection?.parameterIndex === void 0 ? 0 : 1)
  const hasCallerSignal = descriptor.cancellation !== void 0 && values.length === expected + 1
  if (values.length !== expected && !hasCallerSignal) {
    const contract = descriptor.cancellation === void 0
      ? `${String(expected)} argument(s)`
      : `${String(expected)} business argument(s) plus an optional AbortSignal`
    throw new Error(`client api: ${endpoint} expected ${contract}, got ${String(values.length)}`)
  }
  return { endpoint, expected }
}

// ── 负/正对照：守卫判别力证明（真实描述符驱动，与修复状态无关，恒绿）────
test('(MAINT-025) 负/正对照：逐字 gateway 元数守卫拒绝 2 参写调用、放行 3 参（含显式 undefined）— // TDD-GUARD-MAINT-025', async () => {
  const pkg = requirePackage(baseline, 'dsh-api-remotes')
  const { contributions, disposer } = await loadApiRemotesContributions(pkg.dir)
  try {
    const update = descriptorOf(contributions, descriptorIdOf('settings.update'))
    const mutate = descriptorOf(contributions, descriptorIdOf('settings.mutate'))
    const describe = descriptorOf(contributions, descriptorIdOf('settings.describe'))
    const modelCatalog = descriptorOf(contributions, descriptorIdOf('session.modelCatalog'))

    // 负对照：2 参写调用（修复前适配层形状）必被守卫拒绝——错误消息与 RCA
    // §3 实测一致（user 报障「保存失败」的真实抛点）
    for (const [name, descriptor, twoArgs] of [
      ['settings/update', update, ['llm-reasoning', { level: 'medium' }]],
      ['settings/mutate', mutate, ['llm-reasoning', [{ op: 'unset', path: ['models', 'demo/m1'] }]]],
    ]) {
      assert.throws(
        () => gatewayArityGuard(descriptor, twoArgs),
        (error) => {
          assert.match(error.message, new RegExp(`client api: @deepseek-ai/dsh-api-settings-controller#${name} expected 3 argument\\(s\\), got 2`))
          return true
        },
        `守卫必须拒绝 ${name} 的 2 参调用（负对照——证明本判别组对修复前缺陷是 RED 而非假绿）`,
      )
    }
    // 正对照：3 参含显式 undefined 必放行（F1 修复方向实证）
    gatewayArityGuard(update, ['llm-reasoning', { level: 'medium' }, undefined])
    gatewayArityGuard(mutate, ['llm-reasoning', [{ op: 'unset', path: ['models', 'demo/m1'] }], undefined])
    gatewayArityGuard(describe, [])
    gatewayArityGuard(modelCatalog, [])
  } finally {
    await disposer()
  }
})

// ── 负相自证（MAINT-014 教训——防假绿）：探针对伪造工件/篡改判据必须 RED ────
// 伪造树在 os.tmpdir() 隔离构造（不触碰真实环境——破坏性红线 R1：测试场景一律
// 临时目录），证明「断言会红」：探针判据若被篡改/工件伪造，分级机制给出
// FAIL（baseline 源）/ DRIFT（live 源）而非假绿。
test('(FEAT-002/MAINT-014) 负相自证 ×2+：伪造宿主树（锚串缺失/校验器篡改）→ 探针必须红（baseline=FAIL / live=DRIFT 分级各证）', async () => {
  const forgedRoot = mkdtempSync(join(tmpdir(), 'dsh-forged-tree-'))
  try {
    const forge = (name, version, libFiles) => {
      const dir = join(forgedRoot, '@deepseek-ai', name)
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version, type: 'module' }, null, 2))
      for (const [file, text] of Object.entries(libFiles)) writeFileSync(join(dir, 'lib', file), text)
    }
    // 伪造①：dsh-agent-loop 事件锚串全部缺失（宿主移除 agent/request 瀑布的模拟）
    forge('dsh-agent-loop', '9.9.9-forged', { 'index.js': 'export const nothing = true\n' })
    // 伪造②：dsh-settings 导出面完好但 parseSettingsNamespace 被篡改（语义漂移模拟）
    forge('dsh-settings', '9.9.9-forged', {
      'index.js': [
        'export class SettingsConflictError extends Error {}',
        'export class SettingsProvider {}',
        'export { SettingsProvider as default }',
        'export function redactSecrets() {}',
        'const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/',
        'function parseSettingsNamespace(value) {',
        '\treturn "forged:" + value;',
        '}',
      ].join('\n'),
    })
    const forgedLive = { kind: 'live', label: '伪造树（负相）', root: forgedRoot }
    const entry2 = PROBES.find((p) => p.id === 2)
    const entry1 = PROBES.find((p) => p.id === 1)

    // 负相 1a：T 级锚串缺失在 live 源 = DRIFT（BM-2 分级），绝不 PASS
    const r2live = await runEntry(entry2, forgedLive)
    assert.equal(r2live.status, 'DRIFT', `伪造树（live 源）事件锚串缺失必须 DRIFT（实得 ${r2live.status}）：\n${fmt(r2live)}`)
    assert.match(r2live.evidence, /agentRequest.*✗未命中/, '证据必须指明缺失的锚（agentRequest）')

    // 负相 1b：同一伪造在 baseline 源语义 = FAIL（版本失配 fail-closed 先行——
    // 伪造版本号故意不匹配 devDeps 锁版，证明锁版哨兵本身会红）
    const forgedBaseline = { kind: 'baseline', label: '伪造树（负相）', root: forgedRoot }
    await assert.rejects(
      () => runEntry(entry2, forgedBaseline),
      /版本失配|未找到/,
      'baseline 源对伪造版本必须 fail-closed throw（锁版哨兵）',
    )

    // 负相 2：settingsNamespace 路线 B 校验器篡改 → 结构化 FAIL（B+T 条目不降级 DRIFT）
    const r1 = await runEntry(entry1, forgedLive)
    assert.equal(r1.status, 'FAIL', `parseSettingsNamespace 篡改必须 FAIL（实得 ${r1.status}）：\n${fmt(r1)}`)
    assert.match(r1.evidence, /归一化后不一致|路线 B 不可用/, '证据必须落在路线 B 的判别点上')

    // 负相 3（判据函数级）：镜像判等对篡改 mirror 必须失配（R-1 域含 namespaces）
    const tampered = JSON.parse(JSON.stringify((await import('../lib/host-compat.js')).HOST_REMOTE_CONTRACT))
    tampered.namespaces.self = 'llm-forged'
    assert.equal(mirrorMatches(tampered, (await import('../lib/host-compat.js')).HOST_REMOTE_CONTRACT).ok, false, 'mirrorMatches 必须检出 namespaces.self 篡改')
    delete tampered.methods
    assert.equal(mirrorMatches(tampered, (await import('../lib/host-compat.js')).HOST_REMOTE_CONTRACT).ok, false, 'mirrorMatches 必须检出字段删除')

    // 负相 4（判据函数级）：元数表判据对 2 参 update 描述符必须失配
    const forgedDescriptor = (key, params) => ({ id: descriptorIdOf(key), parameters: params.map((name) => ({ name })), cancellation: undefined })
    const forgedContributions = [{ descriptors: [
      forgedDescriptor('settings.describe', []),
      forgedDescriptor('settings.update', ['ns', 'patch']), // ← MAINT-025 缺陷形状
      forgedDescriptor('settings.mutate', ['ns', 'ops', 'expectedRevision']),
      forgedDescriptor('session.modelCatalog', []),
    ] }]
    const arity = checkArityTable(forgedContributions)
    assert.equal(arity.ok, false, 'checkArityTable 必须检出 2 参 update（MAINT-025 缺陷形状）')
    assert.ok(arity.rows.some((row) => row.includes('settings.update') && row.includes('✗')), '失配行必须指明 settings.update')
  } finally {
    rmSync(forgedRoot, { recursive: true, force: true })
  }
})
