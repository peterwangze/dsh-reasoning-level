# dsh-reasoning-level 安装脚本（Windows / PowerShell 5.1+）
# 在线：powershell -ExecutionPolicy Bypass -Command "iex (((irm <你的仓库 install.ps1 地址>) -join [Environment]::NewLine).TrimStart([char]0xFEFF))"
# 离线：解压发行包后，在包目录内执行  .\install.ps1 -LocalPath .
# 环境变量 DSH_HOME 可覆盖配置目录（默认 ~/.dsh）；-Profile 指定目标 profile（默认 web）。
#
# 安装内容：
#   1) 把插件包接入 <DSH_HOME>\profiles\node_modules（junction 优先，失败回退拷贝）；
#   2) 在 <DSH_HOME>\profiles\<Profile>\cordis.patch.yml 幂等插入一行：
#        - id: reasoning-level
#          name: dsh-reasoning-level
#      （dual-face 包：同一行同时提供宿主逻辑与「设置 → 统一推理等级」页面）；
#   3) 若 settings.yaml 还没有 llm-reasoning 节，写入默认配置
#      （enabled: true / level: high），安装后开箱即用。

param(
  [string]$RepoUrl = 'https://github.com/peterwangze/dsh-reasoning-level.git',
  [string]$Ref = 'main',
  [string]$LocalPath = '',
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$script:PluginName = 'dsh-reasoning-level'
$script:RowId = 'reasoning-level'

function Write-Step([string]$text) { Write-Host "==> $text" }

$homeRaw = $env:DSH_HOME
if (-not $homeRaw) { $homeRaw = Join-Path $env:USERPROFILE '.dsh' }
$dshHome = [System.IO.Path]::GetFullPath($homeRaw)
$src = ''
$offline = $false

# ── 1. 定位源码 ────────────────────────────────────────────────────────
if ($LocalPath) {
  $src = [System.IO.Path]::GetFullPath($LocalPath)
  if (-not (Test-Path (Join-Path $src 'package.json'))) {
    Write-Error "离线安装目录无效：$src 下找不到 package.json（请指向解压后的包根目录）"
  }
  $offline = $true
  Write-Step "离线模式：使用本地源码 $src"
} else {
  $src = Join-Path $dshHome "plugins-src\$script:PluginName"
  if (Test-Path (Join-Path $src '.git')) {
    Write-Step "源码目录已存在，git 更新（分支 $Ref）…"
    git -C $src fetch --depth 1 origin $Ref
    if ($LASTEXITCODE -ne 0) {
      Write-Error "git fetch 失败（退出码 $LASTEXITCODE）：无法更新插件源码。请检查网络/代理后重试，或改用离线安装（下载发行包后执行 .\install.ps1 -LocalPath <解压目录>）"
    }
    git -C $src checkout -q $Ref
    if ($LASTEXITCODE -ne 0) {
      Write-Error "git checkout 失败（退出码 $LASTEXITCODE）：请检查后重试，或改用离线安装（下载发行包后执行 .\install.ps1 -LocalPath <解压目录>）"
    }
    git -C $src pull -q --ff-only origin $Ref
    if ($LASTEXITCODE -ne 0) {
      Write-Error "git pull 失败（退出码 $LASTEXITCODE）：无法更新插件源码。请检查网络/代理后重试，或改用离线安装（下载发行包后执行 .\install.ps1 -LocalPath <解压目录>）"
    }
  } else {
    Write-Step "git clone ${RepoUrl}（分支 $Ref）…"
    New-Item -ItemType Directory -Path (Split-Path $src -Parent) -Force | Out-Null
    git clone --depth 1 --branch $Ref $RepoUrl $src
    if ($LASTEXITCODE -ne 0) {
      Write-Error "git clone 失败（退出码 $LASTEXITCODE）：无法访问仓库获取插件源码。请检查网络/代理后重试，或改用离线安装：下载发行包并解压后执行 .\install.ps1 -LocalPath <解压目录>"
    }
    if (-not (Test-Path (Join-Path $src 'package.json'))) {
      Write-Error "git clone 未生成源码目录：$src 下找不到 package.json"
    }
  }
}

# ── 2. 链接 / 拷贝到 profiles\node_modules ─────────────────────────────
$nodeModules = Join-Path $dshHome 'profiles\node_modules'
$dst = Join-Path $nodeModules $script:PluginName
New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null

$linked = $false
if (Test-Path $dst) {
  $item = Get-Item $dst -Force
  $isLink = $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  if (-not $isLink) {
    Write-Error "$dst 已存在且不是链接：请先手动移除后重试"
  }
  Write-Step "链接已存在：$dst"
  $linked = $true
} else {
  try {
    New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
    Write-Step "已创建 junction：$dst -> $src"
    $linked = $true
  } catch {
    Write-Warning "junction 创建失败（$($_.Exception.Message)）：改用目录拷贝"
  }
}

# 依赖解析链接：Node 从 junction 解析到源码真实目录后，插件的
# `@deepseek-ai/*` 依赖也从真实目录向上查找 node_modules——git clone 的
# 源码没有依赖树，必须把 profiles 的平坦依赖树链接进源码目录。拷贝回退
# 路径不需要：插件本体直接落在 profiles\node_modules 下，依赖向上查找即可解析。
if ($linked) {
  $srcNodeModules = Join-Path $src 'node_modules'
  $hasDepTree = $false
  if (Test-Path $srcNodeModules) {
    $depItem = Get-Item $srcNodeModules -Force
    $isDepLink = $depItem.LinkType -or ($depItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isDepLink) {
      Write-Step "依赖链接已存在：$srcNodeModules"
    } else {
      Write-Step "源码自带依赖目录：${srcNodeModules}（跳过依赖链接）"
    }
    $hasDepTree = $true
  } else {
    # 悬空依赖链接：Test-Path 不可见但目录项仍存在，重建前只移除链接本身。
    $dangling = Get-Item $srcNodeModules -Force -ErrorAction SilentlyContinue
    if ($dangling -and ($dangling.LinkType -or ($dangling.Attributes -band [System.IO.FileAttributes]::ReparsePoint))) {
      $dangling.Delete()
    }
  }
  if (-not $hasDepTree) {
    try {
      New-Item -ItemType Junction -Path $srcNodeModules -Target $nodeModules | Out-Null
      Write-Step "已创建依赖链接：$srcNodeModules -> $nodeModules"
    } catch {
      Write-Warning "依赖链接创建失败（$($_.Exception.Message)）：改用目录拷贝"
      (Get-Item $dst -Force).Delete()
      $linked = $false
    }
  }
}
if (-not $linked) {
  # 安全护栏：回退拷贝前必须确认链接已移除，否则 robocopy 会沿 junction
  # 把源码递归拷贝进源码自身，破坏用户目录。
  if (Test-Path $dst) {
    Write-Error "$dst 仍存在（链接移除失败）：已中止拷贝，请手动删除该链接后重试"
  }
  if (-not (Test-Path (Join-Path $src 'package.json'))) {
    Write-Error "源码目录缺失：$src 下找不到 package.json，无法拷贝。请检查 git 步骤是否失败（见上方输出），或改用离线安装"
  }
  Write-Step "拷贝源码到 $dst …"
  robocopy $src $dst /E /XD .git node_modules /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -gt 7) { Write-Error "拷贝失败（robocopy 退出码 $LASTEXITCODE）" }
  Write-Step "拷贝完成：$dst"
}

# ── 3. 幂等写入 cordis.patch.yml（一行 dual-face 宿主行）─────────────
$profileDir = Join-Path $dshHome "profiles\$Profile"
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$patch = Join-Path $profileDir 'cordis.patch.yml'

function New-PatchTemplate {
  @(
    '# Added by dsh-reasoning-level installer: unified default reasoning level for all models.',
    '# - `reasoning-level` : llm-reasoning settings namespace + dynamic per-route defaults',
    '#   (dual-face: also serves the Settings -> 统一推理等级 page)',
    '- insert:',
    '    - id: reasoning-level',
    '      name: dsh-reasoning-level',
    ''
  ) -join "`n"
}

function Add-PatchEntry([string[]]$lines) {
  # 找到 insert 块并插入一行；找不到则按顶层数组追加一个新 insert 元素。
  $insertIndex = -1
  $insertIndent = 0
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^\s*(-\s+)?insert:\s*$') {
      $insertIndex = $i
      $m = [regex]::Match($lines[$i], '^\s*')
      $insertIndent = $m.Value.Length
      break
    }
  }
  if ($insertIndex -lt 0) {
    $newEntry = @(
      '- insert:'
      '    - id: reasoning-level'
      '      name: dsh-reasoning-level'
    )
    # `[]`（空数组 = 禁用层形态）不能与新增条目并存：直接用 insert 条目替换该行。
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($lines[$i] -match '^\s*\[\]\s*$') {
        $lines[$i] = $newEntry[0]
        $result = New-Object System.Collections.Generic.List[string]
        for ($j = 0; $j -le $i; $j++) { $result.Add($lines[$j]) }
        for ($j = 1; $j -lt $newEntry.Length; $j++) { $result.Add($newEntry[$j]) }
        for ($j = $i + 1; $j -lt $lines.Length; $j++) { $result.Add($lines[$j]) }
        return $result.ToArray()
      }
    }
    $lines += ''
    $lines += $newEntry
    return $lines
  }
  # 列表尾部 = insert 行之后、下一个顶层数组元素 / 顶层键之前的最后一个条目行。
  $last = $insertIndex
  $itemIndent = -1
  for ($i = $insertIndex + 1; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    if ($line -match '^\s*$' -or $line -match '^\s*#') { continue }
    $m = [regex]::Match($line, '^\s*')
    $indent = $m.Value.Length
    if ($indent -le $insertIndent) { break }
    if ($itemIndent -lt 0) { $itemIndent = $indent }
    $last = $i
  }
  if ($itemIndent -lt 0) { $itemIndent = 4 }
  $pad = ' ' * $itemIndent
  $result = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -le $last; $i++) { $result.Add($lines[$i]) }
  $result.Add("${pad}- id: reasoning-level")
  $result.Add("${pad}  name: dsh-reasoning-level")
  for ($i = $last + 1; $i -lt $lines.Length; $i++) { $result.Add($lines[$i]) }
  return $result.ToArray()
}

if (-not (Test-Path $patch)) {
  Write-Step "创建 $patch"
  [System.IO.File]::WriteAllText($patch, (New-PatchTemplate), (New-Object System.Text.UTF8Encoding($false)))
} else {
  $content = [System.IO.File]::ReadAllText($patch)
  if ($content.Contains("name: dsh-reasoning-level")) {
    Write-Step "$patch 已配置，跳过"
  } else {
    $lines = ($content -replace "`r`n", "`n").Split("`n")
    $lines = Add-PatchEntry $lines
    [System.IO.File]::WriteAllText($patch, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "已更新 ${patch}（插入 reasoning-level 宿主行）"
  }
}

# ── 4. 幂等写入默认配置（settings.yaml：llm-reasoning 节）────────────
$settingsFile = Join-Path $dshHome 'settings.yaml'
$defaultConfig = @(
  'llm-reasoning:'
  '  enabled: true'
  '  level: high'
) -join "`n"
if (Test-Path $settingsFile) {
  $settingsContent = [System.IO.File]::ReadAllText($settingsFile)
  if ($settingsContent -match '(?m)^llm-reasoning:\s*$') {
    Write-Step "$settingsFile 已含 llm-reasoning 节，跳过默认配置写入"
  } else {
    $nl = if ($settingsContent.EndsWith("`n")) { '' } else { "`n" }
    [System.IO.File]::WriteAllText($settingsFile, $settingsContent + $nl + $defaultConfig + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "已写入默认配置到 ${settingsFile}（enabled: true / level: high）"
  }
} else {
  [System.IO.File]::WriteAllText($settingsFile, $defaultConfig + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "已创建 ${settingsFile}（默认配置）"
}

Write-Host ''
Write-Host "[OK] dsh-reasoning-level 安装完成（源码：$src；profile：$Profile）"
Write-Host '  请重启 DSH，然后在「设置 → 统一推理等级」调整默认等级（默认 high，含 Max 选项）。'
