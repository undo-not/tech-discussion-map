param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactZip,
  [string]$GitHubCliPath = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GitHub CLI\gh.exe'),
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$repository = 'undo-not/tech-discussion-map'
$signerWorkflow = 'undo-not/tech-discussion-map/.github/workflows/tesseract-runtime.yml'
$expected = @{
  contractVersion = '1'
  tesseractVersion = '5.5.3'
  tesseractSourceTagObject = '6951ffe10ce031374bcd04fe400811da1e7e04ad'
  tesseractSourceCommit = 'db0ec62f81b0737fbbe184d8fea40af5738f8eef'
  tesseractSourceSha512 = '6f0ac8da61d989e8c69ed2cc648ddc6cff2d154162bb74624d2de5334266bd2a7e97f6858f012bd66d6bd00dd491e321613c4afb1da7d996d5d9adfda1062fbb'
  vcpkgBaseline = 'ddd0023b0eee70986e42ed49d9d4afb8098f212e'
  vcpkgTriplet = 'x64-windows-static'
  tessdataCommit = '87416418657359cb625c412a48b6e1d6d41c29bd'
  jpnSha256 = '1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d'
  engSha256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  tessdataLicenseSha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
}

function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 verification failed for $Path" }
}

if ($env:OS -ne 'Windows_NT') { throw 'The attested Tesseract installer supports Windows only.' }
$artifactPath = (Resolve-Path -LiteralPath $ArtifactZip).Path
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "Artifact ZIP is missing: $artifactPath" }
if ((Get-Item -LiteralPath $artifactPath).Length -gt 128MB) { throw 'Artifact ZIP exceeds the 128 MiB safety bound.' }
$ghPath = (Resolve-Path -LiteralPath $GitHubCliPath).Path
if (-not (Test-Path -LiteralPath $ghPath -PathType Leaf)) { throw "GitHub CLI is missing: $ghPath" }
$ghSignature = Get-AuthenticodeSignature -LiteralPath $ghPath
$ghSigner = if ($ghSignature.SignerCertificate) { $ghSignature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }
if ($ghSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $ghSigner -ne 'GitHub, Inc.') {
  throw 'GitHub CLI must have a valid GitHub, Inc. Authenticode signature.'
}
& $ghPath attestation verify $artifactPath `
  --repo $repository `
  --signer-workflow $signerWorkflow `
  --source-ref 'refs/heads/main' `
  --deny-self-hosted-runners
if ($LASTEXITCODE -ne 0) { throw 'GitHub artifact provenance verification failed.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($artifactPath)
try {
  $required = @{
    'tesseract.exe' = 100MB
    'tessdata/eng.traineddata' = 8MB
    'tessdata/jpn.traineddata' = 8MB
    'techmap-ocr-build.manifest' = 8KB
    'licenses/tesseract.txt' = 256KB
    'licenses/tessdata-fast.txt' = 256KB
    'licenses/leptonica.txt' = 256KB
  }
  $seen = @{}
  $uncompressedBytes = [long]0
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.Contains(':') -or $name -match '(^|/)\.\.?(?:/|$)') {
      throw "Unsafe path in OCR artifact: $name"
    }
    if ($name.EndsWith('/')) {
      if ($name -notin @('tessdata/', 'licenses/')) { throw "Unexpected directory in OCR artifact: $name" }
      continue
    }
    $limit = if ($required.ContainsKey($name)) { $required[$name] } elseif ($name -match '^licenses/[a-z0-9+.-]+\.txt$') { 256KB } else { throw "Unexpected file in OCR artifact: $name" }
    if ($seen.ContainsKey($name)) { throw "Duplicate file in OCR artifact: $name" }
    if ($entry.Length -gt $limit) { throw "Oversized file in OCR artifact: $name" }
    $uncompressedBytes += $entry.Length
    if ($uncompressedBytes -gt 128MB -or $seen.Count -ge 64) { throw 'OCR artifact expansion exceeds its safety bound.' }
    $seen[$name] = $true
  }
  foreach ($name in $required.Keys) { if (-not $seen.ContainsKey($name)) { throw "Required OCR artifact file is missing: $name" } }
} finally {
  $archive.Dispose()
}

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$extractRoot = Join-Path $tempBase ('techmap-ocr-attested-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractRoot | Out-Null
try {
  Expand-Archive -LiteralPath $artifactPath -DestinationPath $extractRoot
  $manifestPath = Join-Path $extractRoot 'techmap-ocr-build.manifest'
  $manifest = @{}
  foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if ($line -notmatch '^([^=]+)=(.+)$') { throw 'OCR build manifest is malformed.' }
    if ($manifest.ContainsKey($matches[1])) { throw "Duplicate OCR build manifest key: $($matches[1])" }
    $manifest[$matches[1]] = $matches[2]
  }
  if ($manifest.Count -ne ($expected.Count + 1)) { throw 'OCR build manifest has an unexpected field count.' }
  foreach ($entry in $expected.GetEnumerator()) {
    if ($manifest[$entry.Key] -ne $entry.Value) { throw "OCR build manifest trust value is invalid: $($entry.Key)" }
  }
  if ($manifest.tesseractSha256 -notmatch '^[a-f0-9]{64}$') { throw 'OCR build manifest executable hash is invalid.' }

  $tesseractPath = Join-Path $extractRoot 'tesseract.exe'
  $japanesePath = Join-Path $extractRoot 'tessdata\jpn.traineddata'
  $englishPath = Join-Path $extractRoot 'tessdata\eng.traineddata'
  Assert-Hash $tesseractPath $manifest.tesseractSha256
  Assert-Hash $japanesePath $manifest.jpnSha256
  Assert-Hash $englishPath $manifest.engSha256
  Assert-Hash (Join-Path $extractRoot 'licenses\tessdata-fast.txt') $manifest.tessdataLicenseSha256

  $setupArguments = @{
    DistributionDirectory = $extractRoot
    TesseractSha256 = $manifest.tesseractSha256
    JapaneseSha256 = $manifest.jpnSha256
    EnglishSha256 = $manifest.engSha256
    Replace = $Replace
  }
  & (Join-Path $PSScriptRoot 'setup-tesseract.ps1') @setupArguments
} finally {
  $resolvedExtractRoot = [System.IO.Path]::GetFullPath($extractRoot)
  if ($resolvedExtractRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedExtractRoot).StartsWith('techmap-ocr-attested-')) {
    Remove-Item -LiteralPath $resolvedExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
