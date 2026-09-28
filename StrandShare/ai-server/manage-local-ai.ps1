param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Stop', 'Restart', 'Status', 'ControllerStart', 'ControllerStop', 'ControllerStatus', 'InstallControls')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'

$AiRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AiRoot
$PythonExe = Join-Path $AiRoot '.venv\Scripts\python.exe'
$EnvFile = Join-Path $AiRoot '.env'
$RunRoot = Join-Path $AiRoot '.run'
$AiPidFile = Join-Path $RunRoot 'ai.pid'
$ControllerPidFile = Join-Path $RunRoot 'controller.pid'
$LastActivityFile = Join-Path $RunRoot 'last-ai-activity'

function Ensure-RunRoot {
  if (-not (Test-Path -LiteralPath $RunRoot)) {
    New-Item -ItemType Directory -Path $RunRoot | Out-Null
  }
}

function Get-TrackedProcess([string]$PidFile, [string]$ExpectedCommand) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $rawPid = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($rawPid -notmatch '^\d+$') { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$rawPid" -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.CommandLine -notlike "*$ExpectedCommand*") { return $null }
  return $process
}

function Test-LocalPort([int]$Port) {
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-Ai {
  Ensure-RunRoot
  $tracked = Get-TrackedProcess $AiPidFile 'app.main:app'
  if ($null -ne $tracked) {
    Write-Host "[Donivra AI] Already running (PID $($tracked.ProcessId))."
    return
  }
  if (Test-LocalPort 8000) {
    throw 'Port 8000 is already used by an untracked process. Close it before starting Donivra AI.'
  }
  if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw 'Local AI environment is missing. Run npm run ai:setup first.'
  }
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw 'ai-server\.env is missing. Copy .env.example and add the Supabase server credentials.'
  }

  Set-Content -LiteralPath $LastActivityFile -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  $stdout = Join-Path $RunRoot 'ai.stdout.log'
  $stderr = Join-Path $RunRoot 'ai.stderr.log'
  $process = Start-Process -FilePath $PythonExe `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1') `
    -WorkingDirectory $AiRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Set-Content -LiteralPath $AiPidFile -Value $process.Id
  Write-Host "[Donivra AI] Starting (PID $($process.Id)). Models are warming up in the background."
}

function Stop-Ai {
  $tracked = Get-TrackedProcess $AiPidFile 'app.main:app'
  if ($null -ne $tracked) {
    Stop-Process -Id $tracked.ProcessId -Force
    try { Wait-Process -Id $tracked.ProcessId -Timeout 10 -ErrorAction SilentlyContinue } catch {}
    Write-Host '[Donivra AI] Stopped. GPU and model memory were released.'
  } else {
    Write-Host '[Donivra AI] Already stopped.'
  }
  Remove-Item -LiteralPath $AiPidFile -Force -ErrorAction SilentlyContinue
}

function Start-Controller {
  Ensure-RunRoot
  $tracked = Get-TrackedProcess $ControllerPidFile 'app.controller'
  if ($null -ne $tracked) {
    Write-Host "[Donivra AI Controller] Already running (PID $($tracked.ProcessId))."
    return
  }
  if (Test-LocalPort 8010) {
    throw 'Port 8010 is already used by an untracked process. Close it before starting the Donivra controller.'
  }
  if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw 'Local AI environment is missing. Run npm run ai:setup first.'
  }
  $stdout = Join-Path $RunRoot 'controller.stdout.log'
  $stderr = Join-Path $RunRoot 'controller.stderr.log'
  $process = Start-Process -FilePath $PythonExe -ArgumentList @('-m', 'app.controller') `
    -WorkingDirectory $AiRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Set-Content -LiteralPath $ControllerPidFile -Value $process.Id
  Write-Host "[Donivra AI Controller] Starting (PID $($process.Id))."
}

function Stop-Controller {
  $tracked = Get-TrackedProcess $ControllerPidFile 'app.controller'
  if ($null -ne $tracked) {
    Stop-Process -Id $tracked.ProcessId -Force
    try { Wait-Process -Id $tracked.ProcessId -Timeout 10 -ErrorAction SilentlyContinue } catch {}
    Write-Host '[Donivra AI Controller] Stopped.'
  } else {
    Write-Host '[Donivra AI Controller] Already stopped.'
  }
  Remove-Item -LiteralPath $ControllerPidFile -Force -ErrorAction SilentlyContinue
}

function Write-Status([switch]$ControllerOnly) {
  $ai = Get-TrackedProcess $AiPidFile 'app.main:app'
  $controller = Get-TrackedProcess $ControllerPidFile 'app.controller'
  $result = [ordered]@{
    controller = if ($null -ne $controller -and (Test-LocalPort 8010)) { 'ready' } elseif ($null -ne $controller) { 'starting' } else { 'off' }
    controller_pid = if ($null -ne $controller) { $controller.ProcessId } else { $null }
  }
  if (-not $ControllerOnly) {
    $result.ai = if ($null -ne $ai -and (Test-LocalPort 8000)) { 'ready' } elseif ($null -ne $ai) { 'starting' } else { 'off' }
    $result.ai_pid = if ($null -ne $ai) { $ai.ProcessId } else { $null }
  }
  $result | ConvertTo-Json -Compress
}

function New-PowerShellShortcut([string]$Path, [string]$Arguments, [string]$Description) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.Description = $Description
  $shortcut.Save()
}

function Install-Controls {
  Ensure-RunRoot
  $escapedManager = '"' + $PSCommandPath + '"'
  $common = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $escapedManager"
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startup = [Environment]::GetFolderPath('Startup')
  New-PowerShellShortcut (Join-Path $desktop 'Donivra AI On.lnk') "$common Start" 'Start Donivra local AI'
  New-PowerShellShortcut (Join-Path $desktop 'Donivra AI Off.lnk') "$common Stop" 'Stop Donivra local AI'
  New-PowerShellShortcut (Join-Path $startup 'Donivra AI Controller.lnk') "$common ControllerStart" 'Start the lightweight Donivra AI controller at sign-in'
  Start-Controller
  Write-Host '[Donivra AI] Installed desktop On/Off shortcuts and the sign-in controller.'
}

switch ($Action) {
  'Start' { Start-Ai }
  'Stop' { Stop-Ai }
  'Restart' { Stop-Ai; Start-Ai }
  'Status' { Write-Status }
  'ControllerStart' { Start-Controller }
  'ControllerStop' { Stop-Controller }
  'ControllerStatus' { Write-Status -ControllerOnly }
  'InstallControls' { Install-Controls }
}
