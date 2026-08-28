param(
  [Parameter(Mandatory = $true)]
  [string]$PackageZip
)

$ErrorActionPreference = 'Stop'
$zipPath = (Resolve-Path -LiteralPath $PackageZip).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('techmap-portable-test-' + [Guid]::NewGuid().ToString('N'))
$extractRoot = Join-Path $testRoot 'extract'
$localAppData = Join-Path $testRoot 'local-app-data'
$stdoutPath = Join-Path $testRoot 'stdout.log'
$stderrPath = Join-Path $testRoot 'stderr.log'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = $null
$originalLocalAppData = $env:LOCALAPPDATA
$originalNoBrowser = $env:TECHMAP_NO_BROWSER
$originalPath = $env:Path

function Wait-Http([string]$Uri, [System.Diagnostics.Process]$Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) { throw "Portable launcher exited during smoke test with code $($Process.ExitCode)." }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  throw "Timed out waiting for $Uri"
}

function Assert-VerificationFailure([string]$ExpectedText) {
  $output = @(& $powerShellPath -NoProfile -ExecutionPolicy Bypass -File $startPortable -VerifyOnly 2>&1)
  if ($LASTEXITCODE -eq 0) { throw "Tampered portable fixture unexpectedly passed: $ExpectedText" }
  if (($output | Out-String) -notmatch [regex]::Escape($ExpectedText)) { throw "Tampered portable fixture did not fail for the expected reason: $ExpectedText" }
}

New-Item -ItemType Directory -Path $extractRoot, $localAppData -Force | Out-Null
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot
  $packageRoots = @(Get-ChildItem -LiteralPath $extractRoot -Directory)
  if ($packageRoots.Count -ne 1) { throw 'Portable ZIP must contain exactly one top-level directory.' }
  $packageRoot = $packageRoots[0].FullName
  $startPortable = Join-Path $packageRoot 'scripts\start-portable.ps1'
  $env:LOCALAPPDATA = $localAppData
  $env:TECHMAP_NO_BROWSER = '1'
  $env:Path = "$(Join-Path $env:SystemRoot 'System32');$env:SystemRoot"

  $unexpected = Join-Path $packageRoot 'meeting-session.json'
  [IO.File]::WriteAllText($unexpected, '{}', [Text.Encoding]::ASCII)
  Assert-VerificationFailure 'Portable package contains files that are not covered by its manifest.'
  Remove-Item -LiteralPath $unexpected -Force

  $tamperTarget = Join-Path $packageRoot 'runtime\node\node-provenance.json'
  $originalBytes = [IO.File]::ReadAllBytes($tamperTarget)
  try {
    [IO.File]::AppendAllText($tamperTarget, 'tampered', [Text.Encoding]::ASCII)
    Assert-VerificationFailure 'Portable package size verification failed: runtime/node/node-provenance.json'
  } finally { [IO.File]::WriteAllBytes($tamperTarget, $originalBytes) }

  & $powerShellPath -NoProfile -ExecutionPolicy Bypass -File $startPortable -VerifyOnly
  if ($LASTEXITCODE -ne 0) { throw 'Portable verification-only launch failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $localAppData 'TechMapLive\ocr\current\techmap-ocr.manifest') -PathType Leaf)) {
    throw 'Portable first-run OCR installation was not created under isolated LocalAppData.'
  }

  $launcher = Start-Process $powerShellPath -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startPortable, '-NoBrowser') `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Wait-Http 'http://127.0.0.1:3000/' $launcher
  Write-Output 'Portable loopback UI smoke test: PASS'
} finally {
  if ($null -ne $launcher -and -not $launcher.HasExited) { & taskkill.exe /PID $launcher.Id /T /F 2>$null | Out-Null }
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:TECHMAP_NO_BROWSER = $originalNoBrowser
  $env:Path = $originalPath
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
