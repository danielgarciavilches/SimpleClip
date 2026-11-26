# One-time setup on a new PC: gets Python 3.12 + the build tools, and the voice model.
# Needs internet and any Python 3 installed (python.org). Run:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# The app is built with Python 3.12 (the AI library, onnxruntime, doesn't support newer
# versions yet). You don't need to install 3.12 yourself: "uv" downloads a private copy
# into the .python folder here.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .tools\Scripts\uv.exe)) {
    python -m venv .tools
    if ($LASTEXITCODE -ne 0) { throw 'Could not run Python - is it installed and on PATH?' }
    & .\.tools\Scripts\python.exe -m pip install -q uv
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.python'
if (Test-Path .venv) { Remove-Item -Recurse -Force .venv }
& .\.tools\Scripts\uv.exe venv --python 3.12 .venv
if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python 3.12 environment' }
& .\.tools\Scripts\uv.exe pip install --python .venv\Scripts\python.exe -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Installing the build tools failed' }

if (-not (Test-Path models\Kim_Vocal_2.onnx)) {
    Write-Host 'Downloading the voice model (64 MB)...'
    New-Item -ItemType Directory -Force models | Out-Null
    curl.exe -L --fail -o models\Kim_Vocal_2.onnx 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx'
    if ($LASTEXITCODE -ne 0) { throw 'Downloading the voice model failed' }
}

if (-not ((Test-Path bin\ffmpeg.exe) -and (Test-Path bin\ffprobe.exe))) {
    Write-Warning 'bin\ffmpeg.exe and bin\ffprobe.exe are missing. Download "ffmpeg-release-essentials.zip" from https://www.gyan.dev/ffmpeg/builds/ and copy both .exe files from its bin folder into .\bin'
}
Write-Host 'Setup done. Now run: powershell -ExecutionPolicy Bypass -File build.ps1'
