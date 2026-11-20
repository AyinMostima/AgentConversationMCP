# Dot-source to prepare a PowerShell session for building this project.
# Locates the Visual Studio bundled vcpkg and routes vcpkg downloads through
# curl, because vcpkg's built-in WinHTTP client fails behind a local proxy
# (WinHttpSetOption error 87) while curl honors HTTPS_PROXY.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'vswhere.exe not found; install Visual Studio 2022 with the C++ workload.' }
# Several VS 2022 instances can coexist with different bundled vcpkg releases.
# An older vcpkg cannot run current port files, so take the newest executable.
$installs = & $vswhere -products * -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcpkgRoot = $installs | ForEach-Object { Join-Path $_ 'VC\vcpkg' } | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'vcpkg.exe') } |
    Sort-Object { (Get-Item -LiteralPath (Join-Path $_ 'vcpkg.exe')).LastWriteTimeUtc } -Descending | Select-Object -First 1
if (-not $vcpkgRoot) { throw 'No Visual Studio 2022 instance with the vcpkg component was found.' }
$env:VCPKG_ROOT = $vcpkgRoot
$env:X_VCPKG_ASSET_SOURCES = 'clear;x-script,curl.exe -L --fail --retry 5 --retry-delay 2 {url} --output {dst};x-block-origin'
Write-Output "[OK] VCPKG_ROOT=$env:VCPKG_ROOT"
