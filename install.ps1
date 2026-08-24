# dsh-reasoning-level 安装脚本 v2（Windows / PowerShell 5.1+）
#
# v0.6.0 起安装走 DSH 官方插件通道（`dsh plugin --profile <P> add <spec>`，
# 一个 pnpm 转发器）：插件装进 profile 自己的 workspace，由 pnpm 管理，
# dsh.profile.bundles 层列表按安装状态自动维护。
#
# 本脚本不再做任何 node_modules junction / cordis.patch.yml 手改 /
# settings.yaml 写入——旧脚本（v0.2-v0.5 发行版）的 junction 方案曾把
# profiles\node_modules 共享树链成反射环，造成 DSH 无法启动与消息
# fetch 失败级故障（详见 VERIFICATION.md「事故复盘」）。若检测到旧
# 安装残留（junction 地雷），本脚本会先安全清除（只删链接本体，
# 绝不递归删除真实目录）。
#
# 用法：
#   .\install.ps1                      # 安装本目录的插件到 profile web（file: 快照）
#   .\install.ps1 -Link                # 开发模式（link: 直连源码，改代码重启即生效）
#   .\install.ps1 -Profile tui         # 指定 profile
#   .\install.ps1 -Uninstall           # 卸载（官方通道 remove + 残留清理）
#
# 环境要求：dsh 与 pnpm 在 PATH；DSH_HOME 环境变量可覆盖配置目录（默认 ~/.dsh）。

param(
  [string]$Profile = 'web',
  [switch]$Link,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-reasoning-level'

function Write-Step([string]$text) { Write-Host "==> $text" }
function Write-Fail([string]$text) { Write-Host "[X] $text" -ForegroundColor Red; exit 1 }

$homeRaw = $env:DSH_HOME
if (-not $homeRaw) { $homeRaw = Join-Path $env:USERPROFILE '.dsh' }
$dshHome = [System.IO.Path]::GetFullPath($homeRaw)

# ── 0. 前置检查 ────────────────────────────────────────────────────────
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Write-Fail "PATH 上找不到 dsh。请先安装/启动 DSH，或用 README 的官方命令手工安装。"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Fail "PATH 上找不到 pnpm（dsh plugin 依赖它管理 profile workspace）。corepack enable 或 npm i -g pnpm 后重试。"
}

$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'package.json'))) {
  Write-Fail "脚本目录缺 package.json：$src（应从插件包根目录运行）"
}

# ── 1. 旧版 junction 地雷清理（只删链接本体，安全幂等）───────────────
function Remove-LinkOnly([string]$path, [string]$what) {
  if (-not (Test-Path $path)) { return }
  $item = Get-Item $path -Force
  $isLink = $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  if ($isLink) {
    $item.Delete()
    Write-Step "已清除旧 $what 链接：$path"
  } else {
    Write-Host "[!] $path 不是链接而是真实目录，请人工确认后删除（脚本拒绝递归删除真实目录）。" -ForegroundColor Yellow
  }
}

Remove-LinkOnly (Join-Path $dshHome "profiles\node_modules\$PluginName") 'profiles node_modules 接入'
$legacyClone = Join-Path $dshHome "plugins-src\$PluginName"
if (Test-Path $legacyClone) {
  Remove-LinkOnly (Join-Path $legacyClone 'node_modules') '旧源码依赖'
  if (Test-Path $legacyClone) {
    Remove-Item $legacyClone -Recurse -Force
    Write-Step "已删除旧源码克隆：$legacyClone"
  }
  $pluginsSrc = Join-Path $dshHome 'plugins-src'
  if ((Test-Path $pluginsSrc) -and -not (Get-ChildItem $pluginsSrc -Force)) {
    Remove-Item $pluginsSrc -Force
  }
}

# 旧补丁行清理：bundle 层已接管该行；残留会造成双重挂载（重复路由 → 注册抛错）
$patch = Join-Path $dshHome "profiles\$Profile\cordis.patch.yml"
if (Test-Path $patch) {
  $content = [System.IO.File]::ReadAllText($patch)
  if ($content.Contains("name: $PluginName")) {
    $lines = ($content -replace "`r`n", "`n").Split("`n") | Where-Object {
      $_ -notmatch ('^\s*- id: reasoning-level\s*$') -and $_ -notmatch ("^\s*name: $PluginName\s*$")
    }
    [System.IO.File]::WriteAllText($patch, (($lines -join "`n")), (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "已从 $patch 移除旧版手工行（现由 bundle 层自动挂载）"
  }
}

# ── 2. 走官方通道 ──────────────────────────────────────────────────────
if ($Uninstall) {
  Write-Step "卸载：dsh plugin --profile $Profile remove $PluginName"
  dsh plugin --profile $Profile remove $PluginName
  if ($LASTEXITCODE -ne 0) { Write-Fail "卸载失败（退出码 $LASTEXITCODE）。" }
  Write-Host ''
  Write-Host "[OK] $PluginName 已从 profile $Profile 卸载；重启 DSH 生效。"
  Write-Host '     可选清理：先设 llm-reasoning.enabled: false 重启一次还原其写入，再删除 settings.yaml 的 llm-reasoning 节。'
  exit 0
}

# 安装前自检：本包必须是「零 dependencies + 全 peer」形态（v0.6.0 契约）
$pkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Count -gt 0) {
  Write-Fail "package.json 声明了 dependencies（$($pkg.dependencies.PSObject.Properties.Name -join ', ')）——v0.6.0 契约要求为空（宿主包一律 peer）。拒绝安装以防共享依赖树被污染。"
}
if (-not $pkg.dsh.bundle.patch) {
  Write-Fail "package.json 缺 dsh.bundle.patch 声明——dsh 无法把它识别为 profile 层。"
}

# 规格说明（金丝雀实测，2026-08）：pnpm 会把裸目录规格归一化为 link:，
# 而 link: 安装下 Node 从源码真实路径向上解析依赖，永远够不到
# $DSH_HOME/profiles/node_modules 平坦回退树 → 宿主包 peers 全部
# ERR_MODULE_NOT_FOUND。必须显式 file:（内容寻址快照，物化在 profile
# 的 node_modules 下）。link: 仅当源码目录自带完整 node_modules 时可用。
if ($Link) {
  # DOC-001 前置自检：link: 必须能从源码目录实测解析插件的宿主导入面
  # （lib/index.js 顶层 import 的 @deepseek-ai/schemastery / dsh-settings 及其
  # 传递依赖；dsh-llm 等服务由 DSH 运行时注入，不在导入面），否则 DSH
  # 整机启动失败。与插件加载同路径的动态 import 实测，而非仅查 node_modules
  # 是否存在——失败即拒绝并引导 file:。
  $probeSrc = @'
for (const id of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-settings']) {
  await import(id)
}
console.log('LINK_DEP_OK')
'@
  $eapPrev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $src
  try {
    & node --input-type=module -e $probeSrc 2>&1 | Out-Null
    $probeOk = ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $eapPrev
    Pop-Location
  }
  if (-not $probeOk) {
    Write-Fail "link: 模式要求源码目录自带完整 node_modules（能解析宿主包 peers：@deepseek-ai/schemastery、@deepseek-ai/dsh-settings）。当前源码目录缺少这些依赖——link: 安装会让 DSH 启动失败（ERR_MODULE_NOT_FOUND）。请改用默认的 file: 快照，或先在源码目录安装完整依赖后重试。"
  }
}
$spec = if ($Link) { "link:$src" } else { "file:$src" }
Write-Step "安装：dsh plugin --profile $Profile add $spec"
dsh plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) {
  Write-Fail "dsh plugin add 失败（退出码 $LASTEXITCODE）。请检查上方 pnpm 输出；线上 profile 未被修改时可安全重试。"
}

Write-Host ''
Write-Host "[OK] $PluginName 已安装到 profile $Profile（$(if ($Link) { 'link 开发模式' } else { 'file 快照' })）。"
Write-Host '     重启 DSH 后在「设置 → 统一推理等级」查看。'
Write-Host '     强烈建议先按 VERIFICATION.md 的金丝雀流程验证再上工作 profile。'
