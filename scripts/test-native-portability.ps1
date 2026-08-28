param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'vswhere.exe is required for native portability verification.' }
$installation = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($installation)) { throw 'Visual C++ toolchain was not found.' }
$dumpbins = @(Get-ChildItem -LiteralPath (Join-Path $installation 'VC\Tools\MSVC') -Recurse -File -Filter dumpbin.exe | Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\dumpbin\.exe$' } | Sort-Object FullName -Descending)
if ($dumpbins.Count -lt 1) { throw 'dumpbin.exe was not found.' }

$executables = @(
  Join-Path $repositoryRoot 'native\privacy\build\Release\techmap-privacy.exe'
  Join-Path $repositoryRoot 'native\teams-captions\build\Release\techmap-captions.exe'
  Join-Path $repositoryRoot 'native\transcription\build\Release\techmap-transcriber.exe'
  Join-Path $repositoryRoot 'native\windows-audio\build\Release\techmap-audio.exe'
)
foreach ($path in $executables) {
  $resolved = (Resolve-Path -LiteralPath $path).Path
  $dependencies = (& $dumpbins[0].FullName /dependents $resolved 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "dumpbin failed for $resolved" }
  if ($dependencies -match '(?im)^\s*(VCRUNTIME|MSVCP|VCOMP|ucrtbased)[^\s]*\.dll\s*$') {
    throw "Native helper requires a non-system Visual C++ runtime DLL: $resolved"
  }
}
Write-Output 'Native helper static runtime verification: PASS'
