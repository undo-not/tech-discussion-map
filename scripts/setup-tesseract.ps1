param(
  [Parameter(Mandatory = $true)]
  [string]$DistributionDirectory,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$TesseractSha256,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$JapaneseSha256,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$EnglishSha256,
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$expectedVersion = '5.5.3'
$sourceRoot = (Resolve-Path -LiteralPath $DistributionDirectory).Path
$sourceExecutable = Join-Path $sourceRoot 'tesseract.exe'
$sourceJapanese = Join-Path $sourceRoot 'tessdata\jpn.traineddata'
$sourceEnglish = Join-Path $sourceRoot 'tessdata\eng.traineddata'

foreach ($required in @($sourceExecutable, $sourceJapanese, $sourceEnglish)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required Tesseract file is missing: $required" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 verification failed for $Path" }
}

Assert-Hash $sourceExecutable $TesseractSha256
Assert-Hash $sourceJapanese $JapaneseSha256
Assert-Hash $sourceEnglish $EnglishSha256
$versionLine = (& $sourceExecutable --version 2>$null | Select-Object -First 1)
if ($versionLine -notmatch "^tesseract $([regex]::Escape($expectedVersion))(?:\s|$)") {
  throw "Expected Tesseract $expectedVersion after hash verification."
}

$ocrRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TechMapLive\ocr'
$target = Join-Path $ocrRoot 'current'
$stage = Join-Path $ocrRoot ('.stage-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ocrRoot -Force | Out-Null
if ((Test-Path -LiteralPath $target) -and -not $Replace) {
  throw 'A pinned OCR distribution is already installed. Re-run with -Replace to retain it as a previous-* backup and install this verified distribution.'
}

try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $stage -Recurse -Force
  $stageExecutable = Join-Path $stage 'tesseract.exe'
  $stageJapanese = Join-Path $stage 'tessdata\jpn.traineddata'
  $stageEnglish = Join-Path $stage 'tessdata\eng.traineddata'
  Assert-Hash $stageExecutable $TesseractSha256
  Assert-Hash $stageJapanese $JapaneseSha256
  Assert-Hash $stageEnglish $EnglishSha256
  $manifest = @(
    'contractVersion=1'
    "tesseractVersion=$expectedVersion"
    "tesseractSha256=$($TesseractSha256.ToLowerInvariant())"
    "jpnSha256=$($JapaneseSha256.ToLowerInvariant())"
    "engSha256=$($EnglishSha256.ToLowerInvariant())"
  ) -join "`n"
  Set-Content -LiteralPath (Join-Path $stage 'techmap-ocr.manifest') -Value $manifest -Encoding ascii -NoNewline
  if (Test-Path -LiteralPath $target) {
    $backup = Join-Path $ocrRoot ('previous-' + (Get-Date -Format 'yyyyMMddHHmmss'))
    Move-Item -LiteralPath $target -Destination $backup
  }
  Move-Item -LiteralPath $stage -Destination $target
  Write-Output "Installed verified Tesseract $expectedVersion under LocalAppData\TechMapLive\ocr\current."
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
