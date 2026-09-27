param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Stop', 'Restart', 'Status', 'On', 'Off', 'InstallControls')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'

$AiRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AiRoot
$PythonExe = Join-Path $AiRoot '.venv\Scripts\python.exe'
$EnvFile = Join-Path $AiRoot '.env'
$RunRoot = Join-Path $AiRoot '.run'
$PidFile = Join-Path $RunRoot 'local-ai.pid'
$StdoutLog = Join-Path $RunRoot 'local-ai.stdout.log'
$StderrLog = Join-Path $RunRoot 'local-ai.stderr.log'
$HealthUrl = 'http://127.0.0.1:8000/health'
$StartupRoot = [Environment]::GetFolderPath('Startup')
$StartupLauncher = Join-Path $StartupRoot 'Donivra Local AI.cmd'
$DesktopRoot = [Environment]::GetFolderPath('Desktop')

function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }

  $SavedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$SavedPid)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }

  $Process = Get-Process -Id $SavedPid -ErrorAction SilentlyContinue
  if ($null -eq $Process) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }

  $CommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $SavedPid" -ErrorAction SilentlyContinue).CommandLine
  if ($CommandLine -notmatch 'uvicorn\s+app\.main:app' -or $CommandLine -notmatch '--port\s+8000') {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }

  return $Process
}

function Test-Health {
  try {
    $Response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
    return $Response.status -eq 'ok'
  } catch {
    return $false
  }
}

function Start-LocalAi {
  if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw 'Local AI environment is missing. Run npm run ai:setup first.'
  }
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw 'ai-server\.env is missing. Copy .env.example and add the server-only credentials.'
  }

  $Existing = Get-ManagedProcess
  if ($null -ne $Existing) {
    if (Test-Health) {
      Write-Host "[Donivra Local AI] Ready (PID $($Existing.Id))."
    } else {
      Write-Host "[Donivra Local AI] Already starting (PID $($Existing.Id))."
    }
    return
  }

  New-Item -ItemType Directory -Path $RunRoot -Force | Out-Null
  $Arguments = @(
    '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1',
    '--port', '8000',
    '--workers', '1'
  )
  $Process = Start-Process -FilePath $PythonExe `
    -ArgumentList $Arguments `
    -WorkingDirectory $AiRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
  Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ascii

  Write-Host "[Donivra Local AI] Starting in the background (PID $($Process.Id))."
  Write-Host "[Donivra Local AI] Models may need a minute to warm up."

  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 15; $Attempt += 1) {
    Start-Sleep -Seconds 2
    if ($Process.HasExited) {
      $Tail = if (Test-Path -LiteralPath $StderrLog) {
        (Get-Content -LiteralPath $StderrLog -Tail 12) -join [Environment]::NewLine
      } else { '' }
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      throw "Local AI stopped during startup.$([Environment]::NewLine)$Tail"
    }
    if (Test-Health) {
      $Ready = $true
      break
    }
  }

  if ($Ready) {
    Write-Host '[Donivra Local AI] Ready at http://127.0.0.1:8000.'
  } else {
    Write-Host '[Donivra Local AI] Still warming up. Run npm run ai:status to check it.'
  }
}

function Stop-LocalAi {
  $Process = Get-ManagedProcess
  if ($null -eq $Process) {
    Write-Host '[Donivra Local AI] Already stopped.'
    return
  }

  Stop-Process -Id $Process.Id -ErrorAction Stop
  try {
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction Stop
  } catch {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host '[Donivra Local AI] Stopped.'
}

function Show-Status {
  $Process = Get-ManagedProcess
  $AutoStart = Test-Path -LiteralPath $StartupLauncher
  if ($null -eq $Process) {
    Write-Host "[Donivra Local AI] Stopped. Auto-start: $AutoStart"
    return
  }
  if (Test-Health) {
    Write-Host "[Donivra Local AI] Ready (PID $($Process.Id)). Auto-start: $AutoStart"
  } else {
    Write-Host "[Donivra Local AI] Starting or unhealthy (PID $($Process.Id)). Auto-start: $AutoStart"
    Write-Host "[Donivra Local AI] Error log: $StderrLog"
  }
}

function Enable-AutoStart {
  $Command = "@echo off`r`nstart `"`" /min powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" Start`r`n"
  Set-Content -LiteralPath $StartupLauncher -Value $Command -Encoding ascii
  Write-Host '[Donivra Local AI] Auto-start enabled for this Windows account.'
}

function Disable-AutoStart {
  Remove-Item -LiteralPath $StartupLauncher -Force -ErrorAction SilentlyContinue
  Write-Host '[Donivra Local AI] Auto-start disabled.'
}

function New-ControlShortcut([string]$Name, [string]$ShortcutAction) {
  $Shell = New-Object -ComObject WScript.Shell
  $ShortcutPath = Join-Path $DesktopRoot "$Name.lnk"
  $Shortcut = $Shell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = 'powershell.exe'
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $ShortcutAction"
  $Shortcut.WorkingDirectory = $ProjectRoot
  $Shortcut.Description = "$Name control for Donivra Wig Catalog AI"
  $Shortcut.Save()
}

function Install-Controls {
  New-ControlShortcut 'Donivra AI On' 'On'
  New-ControlShortcut 'Donivra AI Off' 'Off'
  New-ControlShortcut 'Donivra AI Status' 'Status'
  Write-Host "[Donivra Local AI] Desktop controls installed in $DesktopRoot."
}

switch ($Action) {
  'Start' { Start-LocalAi }
  'Stop' { Stop-LocalAi }
  'Restart' { Stop-LocalAi; Start-LocalAi }
  'Status' { Show-Status }
  'On' { Enable-AutoStart; Start-LocalAi }
  'Off' { Disable-AutoStart; Stop-LocalAi }
  'InstallControls' { Install-Controls }
}
