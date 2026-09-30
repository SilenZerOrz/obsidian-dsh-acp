# ============================================================================
# install.ps1 — Windows 一键安装器 for obsidian-dsh-acp
# ============================================================================
# 对应 install.sh 的 Windows（PowerShell）实现。行为：
#   1. 通过官方 `dsh plugin --profile <name> add <pkg>` 把插件装进 DSH profile
#   2. 定位 pnpm 安装到 profile 里的适配器 dsh-acp.mjs
#   3. 给 Obsidian "Agent Client" 配置自定义代理（备份后写入 data.json）
#
# 与 install.sh 的关键差异（Windows 踩坑修正，2026-09-19）：
#   - 「插件安装目标 profile」与「适配器运行时 profile」分离：
#       -PluginProfile   插件装进哪个 profile（默认 web，web 面板所在处）
#       -RuntimeProfile  适配器一次性任务用哪个 profile（默认 headless——
#                        位置参数 prompt 只有 headless app 支持；web app
#                        会报 "too many arguments"）
#   - Obsidian env 写入 DSH_BIN=<dsh.cmd 绝对路径>：Node 无法直接 spawn
#     npm 的 dsh（裸名 ENOENT / .cmd EINVAL），适配器内部解析 cmd-shim 后
#     用 node 直连拉起；显式 DSH_BIN 让定位不依赖 PATH 内容
#   - command=node.exe + args=[adapter]（Windows 不能直接 spawn .mjs），
#     并设置 data.json 的 nodePath
#   - Agent Client 的 env 语义是「父环境 + 自定义覆盖」合并（main.js:
#     {...process.env, ...t.env}），因此不写 PATH 条目
#   - -Uninstall 依据 -ObsidianVault 把 data.json 还原到原位
#
# 安全默认：幂等；写入前备份；-DryRun 预演；-Uninstall 还原。
# 开关：-SkipPlugin 跳过 STEP 1 插件安装（只重配 Obsidian）。
#
# 用法：
#   .\install.ps1 -ObsidianVault 'D:\Code\Document' -DryRun
#   .\install.ps1 -ObsidianVault 'D:\Code\Document'
#   .\install.ps1 -ProfileEnv
#   .\install.ps1 -Uninstall -ObsidianVault 'D:\Code\Document'
# ============================================================================
[CmdletBinding()]
param(
  [string]$PluginProfile = ($env:DSH_ACP_PROFILE ?? "web"),
  [string]$RuntimeProfile = "headless",
  [string]$DshHome = ($env:DSH_HOME ?? (Join-Path $env:USERPROFILE ".dsh")),
  [string]$ObsidianVault = "",
  [string]$Package = "",
  [string]$NodeBin = "",
  [switch]$ProfileEnv,
  [switch]$NoObsidian,
  [switch]$SkipPlugin,
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ScriptName = "obsidian-dsh-acp"
$PluginId = "dsh-acp"
$AdapterName = "dsh-acp.mjs"
$Timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$ScriptDir = $PSScriptRoot
$BackupDir = Join-Path $ScriptDir ".install-backups\$Timestamp"

# ---- helpers ---------------------------------------------------------------
function Write-Info    { param([string]$Msg) Write-Host "[install] $Msg" -ForegroundColor Green }
function Write-Warn2   { param([string]$Msg) Write-Host "[install:warning] $Msg" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Msg) Write-Host "[install:error] $Msg" -ForegroundColor Red; exit 1 }
function Write-Vlog    { param([string]$Msg) if ($script:IsVerbose) { Write-Host "[debug] $Msg" -ForegroundColor DarkGray } }
function Write-Say     { param([string]$Msg) if ($DryRun) { Write-Host "[dry-run] $Msg" -ForegroundColor Cyan } else { Write-Info $Msg } }
$script:IsVerbose = ($VerbosePreference -ne "SilentlyContinue")

# ---- -ProfileEnv: 只打印推荐 env，立即退出 --------------------------------
if ($ProfileEnv) {
  Write-Host "Recommended adapter env (Obsidian Agent Client custom agent):"
  Write-Host "  DSH_BIN=<dsh.cmd 绝对路径，如 C:\Users\<you>\AppData\Roaming\npm\dsh.cmd>"
  Write-Host "  DSH_PROFILE=$RuntimeProfile"
  Write-Host "  DSH_ACP_LOG_DIR=<日志目录，推荐 ~\.dsh\dsh-acp\log>"
  Write-Host "说明：Agent Client 的 env 与父环境合并，无需写 PATH；Windows 下适配器解析"
  Write-Host "      dsh.cmd 垫片后用 node 直连拉起 dsh（见 doctor.mjs resolveDshSpawnSpec）。"
  exit 0
}

# ---- -Uninstall -------------------------------------------------------------
if ($Uninstall) {
  Write-Host ""
  Write-Info "UNINSTALL mode"
  $uDsh = (Get-Command dsh -ErrorAction SilentlyContinue).Source
  if ($uDsh) {
    Write-Say "dsh plugin --profile '$PluginProfile' remove '$ScriptName'"
    if (-not $DryRun) {
      & $uDsh plugin --profile $PluginProfile remove $ScriptName 2>&1 | ForEach-Object { Write-Host $_ }
      if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "dsh plugin remove reported non-zero exit (already removed, or differs by profile)."
      } else {
        Write-Info "OK: removed $ScriptName from profile '$PluginProfile'"
      }
    }
  } else {
    Write-Warn2 "dsh not found; skipping DSH plugin removal (may still be present in profile '$PluginProfile')."
  }

  $backupRoot = Join-Path $ScriptDir ".install-backups"
  $newest = Get-ChildItem $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $newest) { Write-Fail "no backup snapshot to restore" }
  Write-Info "restoring snapshot: $($newest.FullName)"
  if (-not $ObsidianVault) {
    Write-Fail "-Uninstall 还原 data.json 需要 -ObsidianVault <vault 路径>"
  }
  $restoreTarget = Join-Path $ObsidianVault ".obsidian\plugins\agent-client\data.json"
  $bk = Get-ChildItem $newest.FullName -Filter "*obsidian-data.json" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($bk) {
    Write-Say "restore $restoreTarget"
    if (-not $DryRun) { Copy-Item $bk.FullName $restoreTarget -Force }
  } else {
    Write-Warn2 "snapshot has no data.json backup; nothing to restore"
  }
  Write-Host ""
  Write-Info "注意：还原后请在 Obsidian 里重载（Ctrl+R）使配置生效。"
  exit 0
}

# ============================================================================
# STEP 0 — 环境探测
# ============================================================================
Write-Host "──────────────────────────────────────────────────────────────"
Write-Info "$ScriptName installer (Windows)"
Write-Host "  plugin-profile : $PluginProfile"
Write-Host "  runtime-profile: $RuntimeProfile"
Write-Host "  dsh-home       : $DshHome"
Write-Host "  obsidian vault : $(if ($ObsidianVault) { $ObsidianVault } else { '<not set>' })"
Write-Host "  package src    : $(if ($Package) { $Package } else { '<auto>' })"
if ($DryRun) { Write-Host "  MODE           : DRY-RUN (no changes)" }

# ---- node -------------------------------------------------------------------
if (-not $NodeBin) {
  $NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $NodeBin -or -not (Test-Path $NodeBin -PathType Leaf)) {
  Write-Fail "node not found. Install Node.js >= 22.13 or pass -NodeBin <path>."
}
Write-Vlog "node: $NodeBin ($(& $NodeBin -v 2>$null))"

# ---- dsh --------------------------------------------------------------------
# 显式解析 dsh.cmd（不要 Get-Command 的第一个结果——那可能是 dsh.ps1，而
# 适配器的 DSH_BIN 解析只认 .cmd/.exe）。安装器自己调用 dsh 时 .cmd/.ps1 皆可。
$DshCmd = $null
$dshAll = Get-Command dsh -All -ErrorAction SilentlyContinue
if ($dshAll) {
  $DshCmd = ($dshAll | Where-Object { $_.Source -like "*.cmd" } | Select-Object -First 1).Source
  if (-not $DshCmd) { $DshCmd = ($dshAll | Where-Object { $_.Source -like "*.exe" } | Select-Object -First 1).Source }
  if (-not $DshCmd) { $DshCmd = ($dshAll | Select-Object -First 1).Source }
}
if (-not $DshCmd -and (Test-Path (Join-Path $DshHome "bin\dsh.cmd") -PathType Leaf -ErrorAction SilentlyContinue)) {
  $DshCmd = Join-Path $DshHome "bin\dsh.cmd"
}
if (-not $DshCmd) {
  Write-Warn2 "dsh not found on PATH; DSH plugin step will be skipped (Obsidian wiring still attempted)."
}
# 只有当解析结果是可被适配器消化的形态（.cmd 垫片 / .exe）时才写入 DSH_BIN
$DshBinForEnv = ""
if ($DshCmd -and ($DshCmd -like "*.cmd" -or $DshCmd -like "*.exe")) { $DshBinForEnv = $DshCmd }
elseif ($DshCmd) {
  Write-Warn2 "dsh resolved to '$DshCmd' (not .cmd/.exe); DSH_BIN env will be omitted (adapter PATH scan will try dsh.cmd)."
}
Write-Vlog "dsh: $DshCmd"

# ============================================================================
# STEP 1 — 把插件装进 DSH profile（官方路径）
# ============================================================================
$Adapter = ""   # 安装后的 dsh-acp.mjs 绝对路径
if ($SkipPlugin) {
  Write-Host ""
  Write-Host "──────────────────────────────────────────────────────────────"
  Write-Info "STEP 1/3 — plugin install skipped (-SkipPlugin)"
} elseif ($DshCmd) {
  Write-Host ""
  Write-Host "──────────────────────────────────────────────────────────────"
  Write-Info "STEP 1/3 — install plugin into DSH profile '$PluginProfile'"

  $pkgArg = $Package
  if (-not $pkgArg) {
    $tgz = Get-ChildItem (Join-Path $ScriptDir "$ScriptName-*.tgz") -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
    if ($tgz) { $pkgArg = $tgz.FullName }
    elseif (Test-Path (Join-Path $ScriptDir "package.json") -PathType Leaf) { $pkgArg = "link:$ScriptDir" }
    else { $pkgArg = $ScriptName }
    Write-Vlog "auto package source: $pkgArg"
  }

  # 本地目录源（link:/file:/裸目录）以 symlink 安装，pnpm 不拉取其自身依赖；
  # 源没有 node_modules 时适配器启动会 ERR_MODULE_NOT_FOUND。先装依赖。
  $srcDir = ""
  if ($pkgArg -match '^link:(.+)$') { $srcDir = $Matches[1] }
  elseif ($pkgArg -match '^file:(.+)$') { $srcDir = $Matches[1] }
  elseif ($pkgArg -and (Test-Path $pkgArg -PathType Container -ErrorAction SilentlyContinue)) { $srcDir = $pkgArg }
  if ($srcDir -and (Test-Path (Join-Path $srcDir "package.json") -PathType Leaf) -and
      -not (Test-Path (Join-Path $srcDir "node_modules") -PathType Container -ErrorAction SilentlyContinue)) {
    Write-Info "  linking local source '$srcDir' — installing its dependencies first"
    if ($DryRun) {
      Write-Say "  (would run: pnpm install --no-frozen-lockfile in '$srcDir')"
    } else {
      $installer = $null
      if (Get-Command pnpm -ErrorAction SilentlyContinue) { $installer = "pnpm" }
      elseif (Get-Command npm -ErrorAction SilentlyContinue) { $installer = "npm" }
      if (-not $installer) {
        Write-Warn2 "  neither pnpm nor npm found; cannot preinstall '$srcDir' deps (adapter may not start)"
      } else {
        Push-Location $srcDir
        try {
          if ($installer -eq "pnpm") { & pnpm install --no-frozen-lockfile 2>&1 | Out-Null }
          else { & npm install 2>&1 | Out-Null }
          if ($LASTEXITCODE -eq 0) { Write-Info "  OK: '$srcDir' deps installed" }
          else { Write-Warn2 "  failed to install deps in '$srcDir' (adapter may not start)" }
        } finally { Pop-Location }
      }
    }
  } elseif ($srcDir) {
    Write-Vlog "  source already has node_modules; skipping preinstall"
  }

  Write-Say "dsh plugin --profile '$PluginProfile' add '$pkgArg'"
  if (-not $DryRun) {
    & $DshCmd plugin --profile $PluginProfile add $pkgArg 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn2 "dsh plugin add reported non-zero exit; continuing (see error above)."
    }
  }
}

# ============================================================================
# STEP 2 — 定位已安装的适配器
# ============================================================================
Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────"
Write-Info "STEP 2/3 — locate installed adapter"
$ProfilePkgDir = Join-Path $DshHome "profiles\$PluginProfile\node_modules\$ScriptName"
$Candidate = Join-Path $ProfilePkgDir $AdapterName

if (Test-Path $Candidate -PathType Leaf -ErrorAction SilentlyContinue) { $Adapter = $Candidate }

if ($Adapter) {
  Write-Info "OK: adapter at $Adapter"
} elseif ($DryRun) {
  Write-Say "  (would locate $Candidate)"
  $Adapter = $Candidate
} else {
  Write-Warn2 "adapter not found at $Candidate. Was STEP 1 run? (no 'dsh' found, or package didn't install there)"
}

# ============================================================================
# STEP 3 — 配置 Obsidian Agent Client 自定义代理
# ============================================================================
if (-not $NoObsidian -and $ObsidianVault) {
  Write-Host ""
  Write-Host "──────────────────────────────────────────────────────────────"
  Write-Info "STEP 3/3 — wire Obsidian custom agent"

  $target = Join-Path $ObsidianVault ".obsidian\plugins\agent-client\data.json"
  if (-not (Test-Path $target -PathType Leaf)) {
    Write-Warn2 "data.json not found at $target; Agent Client not installed in this vault yet."
    exit 0
  }

  Write-Say "backing up $target"
  if (-not $DryRun) {
    New-Item $BackupDir -ItemType Directory -Force | Out-Null
    Copy-Item $target (Join-Path $BackupDir "$(Split-Path $target -Leaf).obsidian-data.json") -Force
  }

  Write-Say "adding/updating customAgents[].{id:'$PluginId'} command=$NodeBin args=[$Adapter]"
  if (-not $DryRun) {
    if (-not $Adapter) {
      Write-Warn2 "no adapter path resolved; not writing Obsidian config (run STEP 1 first)."
    } else {
      try {
        $json = Get-Content $target -Raw | ConvertFrom-Json
        if (-not $json.customAgents) { $json | Add-Member -NotePropertyName customAgents -NotePropertyValue @() }
        $agents = @($json.customAgents)
        $idx = -1
        for ($i = 0; $i -lt $agents.Count; $i++) { if ($agents[$i].id -eq $PluginId) { $idx = $i; break } }

        # env：Agent Client 是「父环境 + 覆盖」合并语义；只管理本脚本负责的键，
        # 其余既有条目（如用户自加的 PATH）原样保留。
        $managed = [ordered]@{}
        if ($DshBinForEnv) { $managed["DSH_BIN"] = $DshBinForEnv }         # dsh.cmd 绝对路径 → 适配器解析垫片后 node 直连
        $managed["DSH_PROFILE"] = $RuntimeProfile                           # 一次性任务必须 headless（web app 不收位置参数）
        $managed["DSH_ACP_LOG_DIR"] = (Join-Path $DshHome "dsh-acp\log")

        $envList = [System.Collections.Generic.List[object]]::new()
        if ($idx -ge 0) {
          foreach ($pair in @($agents[$idx].env)) {
            if ($pair -and $pair.key -and -not $managed.Contains($pair.key)) {
              $envList.Add(@($pair.key, $pair.value))
            }
          }
        } else {
          $agents += [pscustomobject]@{
            id = $PluginId; displayName = "DeepSeek Harness (ACP)"
            command = $NodeBin; args = @(); env = @(); enabled = $true
          }
          $idx = $agents.Count - 1
        }
        foreach ($k in $managed.Keys) { $envList.Add(@($k, $managed[$k])) }
        $agents[$idx].env = @($envList | ForEach-Object { [pscustomobject]@{ key = $_[0]; value = $_[1] } })

        $agents[$idx].command = $NodeBin
        $agents[$idx].args = @($Adapter)
        $agents[$idx].displayName = "DeepSeek Harness (ACP)"
        $agents[$idx].enabled = $true
        $json.customAgents = $agents

        # nodePath：Obsidian 用它前置 PATH（Windows spawn .mjs 必须经 node）
        if ($json.PSObject.Properties["nodePath"]) { $json.nodePath = $NodeBin }
        else { $json | Add-Member -NotePropertyName nodePath -NotePropertyValue $NodeBin }

        $json | ConvertTo-Json -Depth 100 | Set-Content $target -Encoding utf8NoBOM
        Write-Info "OK: custom agent '$PluginId' -> $Adapter (env: $($managed.Keys -join ', '))"
      } catch {
        Write-Warn2 "failed to update ${target}: $($_.Exception.Message); it was backed up — review manually"
      }
    }
  }
} else {
  Write-Host ""
  Write-Host "──────────────────────────────────────────────────────────────"
  Write-Info "STEP 3/3 — Obsidian wiring skipped"
  if ($NoObsidian) { Write-Info "  (-NoObsidian)" } else { Write-Warn2 "  (no -ObsidianVault given; pass it to enable)" }
}

# ============================================================================
# Summary
# ============================================================================
Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────"
Write-Info "done"
if ($DryRun) {
  Write-Info "This was a DRY-RUN. Nothing was changed."
} elseif (Test-Path $BackupDir) {
  Write-Info "backups: $BackupDir"
}
Write-Host @"
  Next steps in Obsidian:
    1. Reload the vault (Ctrl+R or restart Obsidian).
    2. Open Agent Client and pick "DeepSeek Harness (ACP)".
  DSH:
    - If the plugin wasn't active, restart 'dsh web' once.
  Re-run .\install.ps1 any time; it is idempotent.
"@
