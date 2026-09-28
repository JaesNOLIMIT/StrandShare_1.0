param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Stop', 'Restart', 'Status', 'Install')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$WorkerScript = Join-Path $ProjectRoot 'scripts\processSmtpOutbox.mjs'
$EnvFile = Join-Path $ProjectRoot '.env.smtp.local'
$RunRoot = Join-Path $ProjectRoot '.run'
$PidFile = Join-Path $RunRoot 'smtp-worker.pid'

function Ensure-RunRoot {
  if (-not (Test-Path -LiteralPath $RunRoot)) {
    New-Item -ItemType Directory -Path $RunRoot | Out-Null
  }
}

function Get-WorkerProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $rawPid = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($rawPid -notmatch '^\d+$') { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$rawPid" -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.CommandLine -notlike '*processSmtpOutbox.mjs*--loop*') {
    return $null
  }
  return $process
}

function Start-Worker {
  Ensure-RunRoot
  $tracked = Get-WorkerProcess
  if ($null -ne $tracked) {
    Write-Host "[Donivra SMTP] Already running (PID $($tracked.ProcessId))."
    return
  }
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw '.env.smtp.local is missing from the project root.'
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $RunRoot 'smtp-worker.stdout.log'
  $stderr = Join-Path $RunRoot 'smtp-worker.stderr.log'
  $workerArguments = "`"$WorkerScript`" --loop --interval=5 --env-file=`"$EnvFile`""
  $process = Start-Process -FilePath $node `
    -ArgumentList $workerArguments `
    -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Set-Content -LiteralPath $PidFile -Value $process.Id
  Write-Host "[Donivra SMTP] Started (PID $($process.Id)); checking queued email every 5 seconds."
}

function Stop-Worker {
  $tracked = Get-WorkerProcess
  if ($null -ne $tracked) {
    Stop-Process -Id $tracked.ProcessId -Force
    Write-Host '[Donivra SMTP] Stopped.'
  } else {
    Write-Host '[Donivra SMTP] Already stopped.'
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Write-WorkerStatus {
  $tracked = Get-WorkerProcess
  [ordered]@{
    status = if ($null -ne $tracked) { 'running' } else { 'stopped' }
    pid = if ($null -ne $tracked) { $tracked.ProcessId } else { $null }
    interval_seconds = 5
    env_file = $EnvFile
    log_file = Join-Path $RunRoot 'smtp-worker.stdout.log'
  } | ConvertTo-Json -Compress
}

function Install-Worker {
  Ensure-RunRoot
  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'Donivra SMTP Worker.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" Start"
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.Description = 'Start the Donivra local SMTP outbox worker at sign-in'
  $shortcut.Save()
  Start-Worker
  Write-Host '[Donivra SMTP] Installed the Current User sign-in startup shortcut.'
}

switch ($Action) {
  'Start' { Start-Worker }
  'Stop' { Stop-Worker }
  'Restart' { Stop-Worker; Start-Worker }
  'Status' { Write-WorkerStatus }
  'Install' { Install-Worker }
}
