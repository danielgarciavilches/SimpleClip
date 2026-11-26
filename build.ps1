# Builds the portable app into .\SimpleClip-Portable
# Requires: setup.ps1 run once (.venv), ffmpeg.exe / ffprobe.exe in .\bin, models\Kim_Vocal_2.onnx
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $py -m PyInstaller --noconfirm --clean --windowed --name SimpleClip --icon "$PSScriptRoot/src/icon.ico" `
    --version-file "$PSScriptRoot\src\version_info.txt" `
    --exclude-module asyncio --exclude-module multiprocessing --exclude-module decimal `
    --exclude-module xml --exclude-module setuptools `
    --add-data "$PSScriptRoot\src\ui;ui" --distpath build\dist --workpath build\work --specpath build `
    src\app.py
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed' }

# onnxruntime (voice AI) crashes with an access violation if an old msvcp140.dll is loaded,
# and one of the other packages drags in v14.16. Newer versions of this Microsoft runtime are
# backwards compatible, so ship the newest copy available (numpy's or this PC's).
$internal = 'build\dist\SimpleClip\_internal'
$candidates = @(Get-ChildItem "$internal\numpy.libs\msvcp140-*.dll", "$env:WINDIR\System32\msvcp140.dll" -ErrorAction SilentlyContinue)
$newest = $candidates | Sort-Object { [version]$_.VersionInfo.FileVersion.Split(' ')[0] } | Select-Object -Last 1
if ($newest -and [version]$newest.VersionInfo.FileVersion.Split(' ')[0] -ge [version]'14.40') {
    Copy-Item $newest.FullName "$internal\msvcp140.dll" -Force
} else {
    throw 'No msvcp140.dll version 14.40 or newer found - install the latest Microsoft Visual C++ Redistributable'
}

# Windows 10/11 already include the Universal C Runtime. Every extra file in _internal makes the
# first start slower, because antivirus software checks each one of a downloaded app.
Remove-Item "$internal\api-ms-win-*.dll", "$internal\ucrtbase.dll" -ErrorAction SilentlyContinue

$out = Join-Path $PSScriptRoot 'SimpleClip-Portable'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
Copy-Item -Recurse 'build\dist\SimpleClip' $out
New-Item -ItemType Directory -Force (Join-Path $out 'bin') | Out-Null
Copy-Item 'bin\ffmpeg.exe', 'bin\ffprobe.exe' (Join-Path $out 'bin')
New-Item -ItemType Directory -Force (Join-Path $out 'models') | Out-Null
Copy-Item 'models\Kim_Vocal_2.onnx' (Join-Path $out 'models')
Copy-Item 'README.txt' $out
# Lets .NET load the app's libraries when the zip was downloaded with a browser (Windows
# marks those files as coming from the internet, and the window would fail to open).
Copy-Item 'src\SimpleClip.exe.config' $out

# Licenses of everything shipped in the app (explained in THIRD-PARTY-NOTICES.txt)
Copy-Item 'THIRD-PARTY-NOTICES.txt' $out
$lic = Join-Path $out 'licenses'
New-Item -ItemType Directory -Force $lic | Out-Null
Copy-Item 'LICENSE' (Join-Path $lic 'SimpleClip-LICENSE.txt')
Copy-Item 'licenses\*' $lic
$pyHome = (& $py -c 'import sys; print(sys.base_prefix)').Trim()
Copy-Item (Join-Path $pyHome 'LICENSE.txt') (Join-Path $lic 'Python-LICENSE.txt')
$site = '.venv\Lib\site-packages'
foreach ($pkg in 'pywebview', 'onnxruntime', 'numpy', 'pythonnet', 'clr_loader', 'bottle', 'cffi',
                 'pycparser', 'packaging', 'typing_extensions', 'pyinstaller') {
    $info = Get-ChildItem $site -Directory -Filter "$pkg-*.dist-info" | Select-Object -First 1
    if (-not $info) { throw "License info for $pkg not found" }
    $dest = Join-Path $lic $pkg
    New-Item -ItemType Directory -Force $dest | Out-Null
    if (Test-Path "$($info.FullName)\licenses") { Copy-Item -Recurse "$($info.FullName)\licenses\*" $dest }
    else { Copy-Item "$($info.FullName)\LICENSE*", "$($info.FullName)\COPYING*" $dest -ErrorAction SilentlyContinue }
}
Copy-Item "$site\onnxruntime\LICENSE", "$site\onnxruntime\ThirdPartyNotices.txt" (Join-Path $lic 'onnxruntime')
Write-Host "Built: $out"
