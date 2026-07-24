$ErrorActionPreference = 'Stop'

$AiRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvRoot = Join-Path $AiRoot '.venv'
$PythonExe = Join-Path $VenvRoot 'Scripts\python.exe'

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw 'Python Launcher (py.exe) was not found. Install Python 3.10 or 3.11 first.'
}

if (-not (Test-Path -LiteralPath $PythonExe)) {
  Write-Host '[Wig Catalog AI] Creating Python virtual environment...'
  & py -3.10 -m venv $VenvRoot
}

Write-Host '[Wig Catalog AI] Installing local GPU and image packages...'
& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install --index-url https://download.pytorch.org/whl/cu118 torch==2.4.1 torchvision==0.19.1
& $PythonExe -m pip install -r (Join-Path $AiRoot 'requirements.txt')

if (-not (Test-Path -LiteralPath (Join-Path $AiRoot '.env'))) {
  Copy-Item -LiteralPath (Join-Path $AiRoot '.env.example') -Destination (Join-Path $AiRoot '.env')
  Write-Warning 'Created ai-server\.env. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting.'
}

Write-Host '[Wig Catalog AI] Downloading model files once for unlimited local use...'
& $PythonExe -c "from rembg import new_session; new_session('birefnet-general'); print('BiRefNet ready')"
& $PythonExe -c "from transformers import CLIPModel, CLIPProcessor; n='openai/clip-vit-base-patch32'; CLIPProcessor.from_pretrained(n); CLIPModel.from_pretrained(n); print('CLIP ready')"

Write-Host '[Wig Catalog AI] Setup complete.'
