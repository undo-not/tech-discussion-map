param(
  [switch]$ContractOnly
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Assert-Leaf([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description is missing: $Path" }
}

function Assert-Directory([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Description is missing: $Path" }
}

function Get-TechMapLocalAppData {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA must be an absolute path.' }
  return [IO.Path]::GetFullPath($env:LOCALAPPDATA)
}

function Test-PortAvailable([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function New-NodeSetupMessage([string]$Reason) {
  return @"
$Reason
TechMap Live requires Node.js 22.18 or later.
Install the official Node.js LTS package with:
  winget install --id OpenJS.NodeJS.LTS --exact
Then close this PowerShell window, open a new one, and run scripts\start-mvp.ps1 again.
"@.Trim()
}

if ($ContractOnly) {
  foreach ($scriptName in @('build-mvp.ps1', 'build-portable-windows.ps1', 'build-tesseract-runtime.ps1', 'install-attested-tesseract.ps1', 'preflight-mvp.ps1', 'setup-openai-key.ps1', 'start-mvp.ps1', 'start-portable.ps1', 'test-native-portability.ps1', 'test-portable-package.ps1', 'test-preflight-node-guidance.ps1')) {
    $scriptPath = Join-Path $PSScriptRoot $scriptName
    Assert-Leaf $scriptPath "MVP script"
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "PowerShell syntax check failed for $scriptName" }
  }
  $startSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start-mvp.ps1') -Raw
  if ($startSource -match 'techmap-launch|launchUrl|Start-Process\s+[^\r\n]*Secret') { throw 'Launch secret must not appear in a URL or browser process argument.' }
  foreach ($requiredPattern in @('Set-WebLaunchSecret \$launchSecret', "Start-Process 'http://127\.0\.0\.1:3000/'", "@\(\`$webCli, 'start', '--hostname', '127\.0\.0\.1', '--port', '3000'\)", "HOST = '127\.0\.0\.1'", "PORT = '3000'", 'taskkill\.exe /PID \$Process\.Id /T /F')) {
    if ($startSource -notmatch $requiredPattern) { throw "MVP launcher behavior is missing: $requiredPattern" }
  }
  foreach ($reason in @('Node.js was not found on PATH.', 'The installed Node.js version is unsupported: v20.0.0')) {
    $message = New-NodeSetupMessage $reason
    foreach ($requiredText in @('Node.js 22.18 or later', 'winget install --id OpenJS.NodeJS.LTS --exact', 'close this PowerShell window, open a new one')) {
      if ($message -notmatch [regex]::Escape($requiredText)) { throw "Node.js recovery guidance is missing: $requiredText" }
    }
  }
  Write-Output 'MVP launcher contract: PASS'
  exit 0
}

if ($env:OS -ne 'Windows_NT') { throw 'TechMap Live MVP runtime supports Windows only.' }
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  throw (New-NodeSetupMessage 'Node.js was not found on PATH.')
}
$nodeVersionOutput = @()
try {
  $nodeVersionOutput = @(& $node.Source --version 2>&1)
  $nodeExitCode = $LASTEXITCODE
} catch {
  throw (New-NodeSetupMessage "Node.js could not be started: $($_.Exception.Message)")
}
$nodeVersionText = ($nodeVersionOutput | Out-String).Trim()
$nodeVersion = $null
if ($nodeExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText) -or $nodeVersionText -notmatch '^v(?<version>\d+\.\d+\.\d+)$' -or -not [Version]::TryParse($matches.version, [ref]$nodeVersion)) {
  throw (New-NodeSetupMessage "The Node.js version could not be verified: $nodeVersionText")
}
if ($nodeVersion -lt [Version]'22.18.0') {
  throw (New-NodeSetupMessage "The installed Node.js version is unsupported: $nodeVersionText")
}

$webRuntimePath = if ($env:TECHMAP_PORTABLE_ROOT) {
  Join-Path $repositoryRoot 'app\dist\standalone\server.js'
} else {
  Join-Path $repositoryRoot 'app\node_modules\vinext\dist\cli.js'
}
$required = @(
  @{ Path = $webRuntimePath; Description = 'Web runtime' },
  @{ Path = Join-Path $repositoryRoot 'native\teams-captions\build\Release\techmap-captions.exe'; Description = 'Teams caption helper' },
  @{ Path = Join-Path $repositoryRoot 'native\privacy\build\Release\techmap-privacy.exe'; Description = 'Privacy helper' }
)
foreach ($item in $required) { Assert-Leaf $item.Path $item.Description }
$webBuildDirectory = if ($env:TECHMAP_PORTABLE_ROOT) {
  Join-Path $repositoryRoot 'app\dist\standalone\dist\server'
} else {
  Join-Path $repositoryRoot 'app\dist\server'
}
Assert-Directory $webBuildDirectory 'Production web build'

$localAppData = Get-TechMapLocalAppData
$ocrRoot = Join-Path $localAppData 'TechMapLive\ocr\current'
$manifestPath = Join-Path $ocrRoot 'techmap-ocr.manifest'
$tesseractPath = Join-Path $ocrRoot 'tesseract.exe'
$japanesePath = Join-Path $ocrRoot 'tessdata\jpn.traineddata'
$englishPath = Join-Path $ocrRoot 'tessdata\eng.traineddata'
foreach ($item in @(
  @{ Path = $manifestPath; Description = 'Pinned OCR manifest' },
  @{ Path = $tesseractPath; Description = 'Pinned Tesseract executable' },
  @{ Path = $japanesePath; Description = 'Pinned Japanese OCR data' },
  @{ Path = $englishPath; Description = 'Pinned English OCR data' }
)) { Assert-Leaf $item.Path $item.Description }

$manifest = @{}
foreach ($line in Get-Content -LiteralPath $manifestPath) {
  if ($line -notmatch '^([^=]+)=(.+)$') { throw 'Pinned OCR manifest is malformed.' }
  $manifest[$matches[1]] = $matches[2]
}
if ($manifest.contractVersion -ne '1' -or $manifest.tesseractVersion -ne '5.5.3') { throw 'Pinned OCR manifest version is unsupported.' }
foreach ($entry in @(
  @{ Path = $tesseractPath; Key = 'tesseractSha256' },
  @{ Path = $japanesePath; Key = 'jpnSha256' },
  @{ Path = $englishPath; Key = 'engSha256' }
)) {
  if ($manifest[$entry.Key] -notmatch '^[a-f0-9]{64}$') { throw "Pinned OCR hash is missing: $($entry.Key)" }
  $actual = (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $manifest[$entry.Key]) { throw "Pinned OCR hash verification failed: $($entry.Key)" }
}

foreach ($port in @(3000, 43117)) { if (-not (Test-PortAvailable $port)) { throw "Loopback port $port is already in use." } }

$fallback = @(
  Join-Path $repositoryRoot 'native\windows-audio\build\Release\techmap-audio.exe'
  Join-Path $repositoryRoot 'native\transcription\build\Release\techmap-transcriber.exe'
  Join-Path $localAppData 'TechMapLive\models\ggml-tiny.bin'
)
$fallbackReady = ($fallback | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -eq 0
Write-Output 'Required OCR-first runtime: PASS'
Write-Output "Explicit audio fallback: $(if ($fallbackReady) { 'AVAILABLE' } else { 'UNAVAILABLE (optional)' })"
