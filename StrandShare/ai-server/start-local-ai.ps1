$ErrorActionPreference = 'Stop'

$AiRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = Join-Path $AiRoot '.venv\Scripts\python.exe'
$EnvFile = Join-Path $AiRoot '.env'

if (-not (Test-Path -LiteralPath $PythonExe)) {
  throw 'Local AI environment is missing. Run ai-server\setup-local-ai.ps1 first.'
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw 'ai-server\.env is missing. Copy .env.example and add the Supabase server credentials.'
}

Set-Location -LiteralPath $AiRoot
& $PythonExe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
