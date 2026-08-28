param(
  [switch]$VerifyOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $packageRoot 'techmap-portable.manifest.json'

function Assert-PortableManifest {
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Portable package manifest is missing: $manifestPath" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.contractVersion -ne 1 -or $manifest.target -ne 'windows-x64' -or $manifest.nodeVersion -ne '22.23.2' -or
      $manifest.nodeArchiveSha256 -ne '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97' -or
      $null -eq $manifest.files -or $manifest.files.Count -lt 1) {
    throw 'Portable package manifest contract is invalid.'
  }

  $rootPrefix = $packageRoot.TrimEnd('\') + '\'
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    $relativePath = [string]$entry.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or $relativePath.Contains('..') -or
        [string]$entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0 -or -not $seen.Add($relativePath)) {
      throw "Portable package manifest entry is invalid: $relativePath"
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $packageRoot $relativePath.Replace('/', '\')))
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "Portable package file is missing or outside the package: $relativePath"
    }
    $file = Get-Item -LiteralPath $candidate
    if ($file.Length -ne [long]$entry.size) { throw "Portable package size verification failed: $relativePath" }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne [string]$entry.sha256) { throw "Portable package hash verification failed: $relativePath" }
  }

  $actualFiles = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -File | ForEach-Object {
    $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
  } | Where-Object { $_ -ne 'techmap-portable.manifest.json' })
  if ($actualFiles.Count -ne $seen.Count -or ($actualFiles | Where-Object { -not $seen.Contains($_) }).Count -ne 0) {
    throw 'Portable package contains files that are not covered by its manifest.'
  }
  return $manifest
}

function Read-KeyValueManifest([string]$Path) {
  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^([^=]+)=(.+)$' -or $result.ContainsKey($matches[1])) { throw "Runtime manifest is malformed: $Path" }
    $result[$matches[1]] = $matches[2]
  }
  return $result
}

function Get-TechMapLocalAppData {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA must be an absolute path.' }
  return [IO.Path]::GetFullPath($env:LOCALAPPDATA)
}

[void](Assert-PortableManifest)
$nodeRoot = Join-Path $packageRoot 'runtime\node'
$nodePath = Join-Path $nodeRoot 'node.exe'
$nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v22.23.2') { throw "Bundled Node.js version verification failed: $nodeVersion" }

$ocrSource = Join-Path $packageRoot 'runtime\ocr'
$ocrBuildManifestPath = Join-Path $ocrSource 'techmap-ocr-build.manifest'
$ocrBuildManifest = Read-KeyValueManifest $ocrBuildManifestPath
if ($ocrBuildManifest.contractVersion -ne '1' -or $ocrBuildManifest.tesseractVersion -ne '5.5.3') { throw 'Bundled OCR build manifest is unsupported.' }
foreach ($key in @('tesseractSha256', 'jpnSha256', 'engSha256')) {
  if ($ocrBuildManifest[$key] -notmatch '^[a-f0-9]{64}$') { throw "Bundled OCR hash is invalid: $key" }
}

$localOcr = Join-Path (Get-TechMapLocalAppData) 'TechMapLive\ocr\current'
if (-not (Test-Path -LiteralPath $localOcr)) {
  & (Join-Path $PSScriptRoot 'setup-tesseract.ps1') `
    -DistributionDirectory $ocrSource `
    -TesseractSha256 $ocrBuildManifest.tesseractSha256 `
    -JapaneseSha256 $ocrBuildManifest.jpnSha256 `
    -EnglishSha256 $ocrBuildManifest.engSha256
}

$previousPath = $env:Path
$previousPortableRoot = $env:TECHMAP_PORTABLE_ROOT
try {
  $env:Path = "$nodeRoot;$previousPath"
  $env:TECHMAP_PORTABLE_ROOT = $packageRoot
  if ($VerifyOnly) {
    & (Join-Path $PSScriptRoot 'preflight-mvp.ps1')
    Write-Output 'TechMap Live portable package: PASS'
    exit 0
  }
  & (Join-Path $PSScriptRoot 'start-mvp.ps1') -NoBrowser:$NoBrowser
} finally {
  $env:Path = $previousPath
  $env:TECHMAP_PORTABLE_ROOT = $previousPortableRoot
}
