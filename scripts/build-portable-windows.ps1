param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OcrRuntimeDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$ocrRoot = (Resolve-Path -LiteralPath $OcrRuntimeDirectory).Path
$nodeVersion = '22.23.2'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
$nodeArchiveSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'

function Assert-Leaf([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description is missing: $Path" }
}

function Assert-Directory([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Description is missing: $Path" }
}

function Copy-PortableLeaf([string]$Source, [string]$RelativeDestination) {
  Assert-Leaf $Source $RelativeDestination
  $destination = Join-Path $outputRoot $RelativeDestination
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $destination
}

function Copy-PortableDirectory([string]$Source, [string]$RelativeDestination) {
  Assert-Directory $Source $RelativeDestination
  $reparsePoints = @(Get-ChildItem -LiteralPath $Source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($reparsePoints.Count -ne 0) { throw "Portable source directory contains a reparse point: $Source" }
  $destination = Join-Path $outputRoot $RelativeDestination
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $destination -Recurse -Force
}

if ($env:OS -ne 'Windows_NT') { throw 'Windows portable packaging supports Windows only.' }
if (Test-Path -LiteralPath $outputRoot) { throw "OutputDirectory must not already exist: $outputRoot" }
Assert-Directory (Join-Path $repositoryRoot 'app\dist\standalone') 'Vinext standalone build'
Assert-Leaf (Join-Path $ocrRoot 'techmap-ocr-build.manifest') 'OCR build manifest'

$nativeFiles = @(
  'native\privacy\build\Release\techmap-privacy.exe',
  'native\teams-captions\build\Release\techmap-captions.exe',
  'native\transcription\build\Release\techmap-transcriber.exe',
  'native\windows-audio\build\Release\techmap-audio.exe'
)
foreach ($relative in $nativeFiles) { Assert-Leaf (Join-Path $repositoryRoot $relative) $relative }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('techmap-portable-build-' + [Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot $nodeArchiveName
$extractRoot = Join-Path $tempRoot 'node'
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  Invoke-WebRequest -Uri $nodeArchiveUrl -OutFile $archivePath
  $actualArchiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualArchiveHash -ne $nodeArchiveSha256) { throw 'Pinned Node.js archive SHA-256 verification failed.' }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
  $nodeSource = Join-Path $extractRoot "node-v$nodeVersion-win-x64"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $versionOutput = (& (Join-Path $nodeSource 'node.exe') --version 2>&1 | Out-String).Trim()
    $versionExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($versionExitCode -ne 0 -or $versionOutput -ne "v$nodeVersion") { throw "Pinned Node.js runtime version verification failed: $versionOutput" }

  New-Item -ItemType Directory -Path $outputRoot | Out-Null
  Copy-PortableLeaf (Join-Path $repositoryRoot 'TechMapLive.cmd') 'TechMapLive.cmd'
  foreach ($script in @('preflight-mvp.ps1', 'setup-openai-key.ps1', 'setup-zoom-rtms.ps1', 'setup-tesseract.ps1', 'start-mvp.ps1', 'start-portable.ps1')) {
    Copy-PortableLeaf (Join-Path $repositoryRoot "scripts\$script") "scripts\$script"
  }
  Copy-PortableLeaf (Join-Path $repositoryRoot 'docs\specs\windows-portable-distribution.md') 'PORTABLE_README.md'

  Copy-PortableDirectory (Join-Path $repositoryRoot 'app\dist\standalone') 'app\dist\standalone'
  Copy-PortableDirectory (Join-Path $repositoryRoot 'app\adapters') 'app\adapters'
  Copy-PortableDirectory (Join-Path $repositoryRoot 'app\domain') 'app\domain'
  foreach ($module in @('local-transcription-host.mjs', 'privacy-store.mjs', 'teams-audio-bridge.mjs', 'zoom-credential-signer.mjs', 'zoom-rtms-bridge.mjs', 'zoom-webhook-host.mjs')) {
    Copy-PortableLeaf (Join-Path $repositoryRoot "companion\$module") "companion\$module"
  }
  foreach ($relative in $nativeFiles) { Copy-PortableLeaf (Join-Path $repositoryRoot $relative) $relative }
  Copy-PortableDirectory $ocrRoot 'runtime\ocr'
  Copy-PortableLeaf (Join-Path $nodeSource 'node.exe') 'runtime\node\node.exe'
  Copy-PortableLeaf (Join-Path $nodeSource 'LICENSE') 'runtime\node\LICENSE.txt'

  $nodeProvenance = [ordered]@{
    source = $nodeArchiveUrl
    version = $nodeVersion
    archiveSha256 = $nodeArchiveSha256
    includedFiles = @('node.exe', 'LICENSE.txt')
  } | ConvertTo-Json -Depth 3
  [IO.File]::WriteAllText((Join-Path $outputRoot 'runtime\node\node-provenance.json'), $nodeProvenance + "`n", [Text.UTF8Encoding]::new($false))

  $forbidden = @(Get-ChildItem -LiteralPath $outputRoot -Recurse -Force -File | Where-Object {
    $relative = $_.FullName.Substring($outputRoot.Length + 1).Replace('\', '/')
    $relative -match '(^|/)(\.env(?:\..*)?|data/local|\.wrangler|\.git)(/|$)' -or
    $_.Name -match '^(credentials?|session|meeting|transcript|capture|screenshot).+\.(json|jsonl|txt|log|db|sqlite|sqlite3)$' -or
    $_.Extension -in @('.wav', '.mp3', '.flac', '.pcm', '.sqlite', '.sqlite3', '.db', '.jsonl')
  })
  if ($forbidden.Count -ne 0) { throw "Sensitive/local-only file name rejected from portable package: $($forbidden[0].FullName)" }
  foreach ($file in Get-ChildItem -LiteralPath $outputRoot -Recurse -Force -File) {
    if ($file.Length -le 2MB) {
      $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
      if ($content -match 'sk-[A-Za-z0-9_-]{20,}' -or $content -match '(?im)(?:ZOOM_CLIENT_SECRET|ZM_RTMS_SECRET|ZOOM_WEBHOOK_SECRET)\s*=\s*[^<\s][^\r\n]{15,}') {
        throw "Credential pattern rejected from portable package: $($file.FullName)"
      }
    }
  }

  $files = @(Get-ChildItem -LiteralPath $outputRoot -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($outputRoot.Length + 1).Replace('\', '/')
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    contractVersion = 1
    product = 'TechMap Live'
    target = 'windows-x64'
    nodeVersion = $nodeVersion
    nodeArchiveSha256 = $nodeArchiveSha256
    files = $files
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $outputRoot 'techmap-portable.manifest.json'), $manifest + "`n", [Text.UTF8Encoding]::new($false))
  Write-Output "Built TechMap Live Windows x64 portable directory: $outputRoot"
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTemp).StartsWith('techmap-portable-build-')) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
