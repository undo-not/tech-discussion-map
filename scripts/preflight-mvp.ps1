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

function Test-PortAvailable([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

if ($ContractOnly) {
  foreach ($scriptName in @('build-mvp.ps1', 'preflight-mvp.ps1', 'start-mvp.ps1')) {
    $scriptPath = Join-Path $PSScriptRoot $scriptName
    Assert-Leaf $scriptPath "MVP script"
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "PowerShell syntax check failed for $scriptName" }
  }
  $startSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start-mvp.ps1') -Raw
  if ($startSource -match 'techmap-launch|launchUrl|Start-Process\s+[^\r\n]*Secret') { throw 'Launch secret must not appear in a URL or browser process argument.' }
  foreach ($requiredPattern in @('Set-WebLaunchSecret \$launchSecret', "Start-Process 'http://127\.0\.0\.1:3000/'", "@\(\`$webCli, 'start', '--hostname', '127\.0\.0\.1', '--port', '3000'\)", 'taskkill\.exe /PID \$Process\.Id /T /F')) {
    if ($startSource -notmatch $requiredPattern) { throw "MVP launcher behavior is missing: $requiredPattern" }
  }
  Write-Output 'MVP launcher contract: PASS'
  exit 0
}

if ($env:OS -ne 'Windows_NT') { throw 'TechMap Live MVP runtime supports Windows only.' }
$node = Get-Command node -ErrorAction Stop
$nodeVersion = (& $node.Source --version).TrimStart('v').Split('.')
if ([int]$nodeVersion[0] -lt 22 -or ([int]$nodeVersion[0] -eq 22 -and [int]$nodeVersion[1] -lt 18)) {
  throw 'Node.js 22.18 or later is required.'
}

$required = @(
  @{ Path = Join-Path $repositoryRoot 'app\node_modules\vinext\dist\cli.js'; Description = 'Web dependencies' },
  @{ Path = Join-Path $repositoryRoot 'native\teams-captions\build\Release\techmap-captions.exe'; Description = 'Teams caption helper' },
  @{ Path = Join-Path $repositoryRoot 'native\privacy\build\Release\techmap-privacy.exe'; Description = 'Privacy helper' }
)
foreach ($item in $required) { Assert-Leaf $item.Path $item.Description }
Assert-Directory (Join-Path $repositoryRoot 'app\dist\server') 'Production web build'

$ocrRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TechMapLive\ocr\current'
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
  Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TechMapLive\models\ggml-tiny.bin'
)
$fallbackReady = ($fallback | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -eq 0
Write-Output 'Required OCR-first runtime: PASS'
Write-Output "Explicit audio fallback: $(if ($fallbackReady) { 'AVAILABLE' } else { 'UNAVAILABLE (optional)' })"
