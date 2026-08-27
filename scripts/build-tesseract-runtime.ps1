param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$tesseractTagObject = '6951ffe10ce031374bcd04fe400811da1e7e04ad'
$tesseractCommit = 'db0ec62f81b0737fbbe184d8fea40af5738f8eef'
$tesseractSourceSha512 = '6f0ac8da61d989e8c69ed2cc648ddc6cff2d154162bb74624d2de5334266bd2a7e97f6858f012bd66d6bd00dd491e321613c4afb1da7d996d5d9adfda1062fbb'
$vcpkgBaseline = 'ddd0023b0eee70986e42ed49d9d4afb8098f212e'
$tessdataCommit = '87416418657359cb625c412a48b6e1d6d41c29bd'
$englishSha256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
$japaneseSha256 = '1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d'
$tessdataLicenseSha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE" }
}

function Assert-Hash([string]$Path, [string]$Algorithm, [string]$Expected) {
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "$Algorithm verification failed for $Path" }
}

if ($env:OS -ne 'Windows_NT') { throw 'The attested Tesseract runtime build supports Windows only.' }
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw "OutputDirectory must not already exist: $outputRoot" }

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workRoot = Join-Path $tempBase ('techmap-tesseract-build-' + [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $workRoot 'tesseract-source.tar.gz'
$sourceRoot = Join-Path $workRoot "tesseract-$tesseractCommit"
$vcpkgRoot = Join-Path $workRoot 'vcpkg'
$vcpkgInstalled = Join-Path $workRoot 'vcpkg-installed'
$buildRoot = Join-Path $workRoot 'build'
$manifestRoot = Join-Path $PSScriptRoot 'tesseract-runtime'

New-Item -ItemType Directory -Path $workRoot | Out-Null
try {
  Invoke-WebRequest -Uri "https://github.com/tesseract-ocr/tesseract/archive/$tesseractCommit.tar.gz" -OutFile $archive
  Assert-Hash $archive 'SHA512' $tesseractSourceSha512
  Invoke-Native 'tar.exe' @('-xf', $archive, '-C', $workRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'VERSION') -PathType Leaf)) { throw 'Pinned Tesseract source layout is invalid.' }
  if ((Get-Content -LiteralPath (Join-Path $sourceRoot 'VERSION') -Raw).Trim() -ne '5.5.3') { throw 'Pinned Tesseract source version is invalid.' }

  New-Item -ItemType Directory -Path $vcpkgRoot | Out-Null
  Invoke-Native 'git.exe' @('-C', $vcpkgRoot, 'init')
  Invoke-Native 'git.exe' @('-C', $vcpkgRoot, 'remote', 'add', 'origin', 'https://github.com/microsoft/vcpkg.git')
  Invoke-Native 'git.exe' @('-C', $vcpkgRoot, 'fetch', '--depth', '1', 'origin', $vcpkgBaseline)
  Invoke-Native 'git.exe' @('-C', $vcpkgRoot, 'checkout', '--detach', 'FETCH_HEAD')
  $resolvedBaseline = (& git.exe -C $vcpkgRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedBaseline -ne $vcpkgBaseline) { throw 'Pinned vcpkg baseline checkout failed.' }
  Invoke-Native (Join-Path $vcpkgRoot 'bootstrap-vcpkg.bat') @('-disableMetrics')
  Invoke-Native (Join-Path $vcpkgRoot 'vcpkg.exe') @(
    'install',
    '--triplet', 'x64-windows-static',
    "--x-manifest-root=$manifestRoot",
    "--x-install-root=$vcpkgInstalled",
    '--clean-after-build'
  )

  Invoke-Native 'cmake.exe' @(
    '-S', $sourceRoot,
    '-B', $buildRoot,
    '-A', 'x64',
    "-DCMAKE_TOOLCHAIN_FILE=$(Join-Path $vcpkgRoot 'scripts\buildsystems\vcpkg.cmake')",
    "-DVCPKG_INSTALLED_DIR=$vcpkgInstalled",
    '-DVCPKG_TARGET_TRIPLET=x64-windows-static',
    '-DVCPKG_MANIFEST_MODE=OFF',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWIN32_MT_BUILD=ON',
    '-DBUILD_TRAINING_TOOLS=OFF',
    '-DBUILD_TESTS=OFF',
    '-DDISABLE_ARCHIVE=ON',
    '-DDISABLE_CURL=ON',
    '-DGRAPHICS_DISABLED=ON',
    '-DOPENMP_BUILD=OFF',
    '-DINSTALL_CONFIGS=OFF',
    '-DENABLE_NATIVE=OFF',
    '-DSW_BUILD=OFF'
  )
  Invoke-Native 'cmake.exe' @('--build', $buildRoot, '--config', 'Release', '--target', 'tesseract')

  $executables = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Filter 'tesseract.exe')
  if ($executables.Count -ne 1) { throw "Expected one built tesseract.exe, found $($executables.Count)." }
  $versionOutput = (& $executables[0].FullName --version 2>&1 | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '^tesseract 5\.5\.3(?:\s|$)') { throw 'Built Tesseract version verification failed.' }

  New-Item -ItemType Directory -Path (Join-Path $outputRoot 'tessdata') -Force | Out-Null
  Copy-Item -LiteralPath $executables[0].FullName -Destination (Join-Path $outputRoot 'tesseract.exe')
  foreach ($model in @(
    @{ Name = 'eng'; Hash = $englishSha256 },
    @{ Name = 'jpn'; Hash = $japaneseSha256 }
  )) {
    $modelPath = Join-Path $outputRoot "tessdata\$($model.Name).traineddata"
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$tessdataCommit/$($model.Name).traineddata" -OutFile $modelPath
    Assert-Hash $modelPath 'SHA256' $model.Hash
  }

  $licenseRoot = Join-Path $outputRoot 'licenses'
  New-Item -ItemType Directory -Path $licenseRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination (Join-Path $licenseRoot 'tesseract.txt')
  $tessdataLicense = Join-Path $licenseRoot 'tessdata-fast.txt'
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$tessdataCommit/LICENSE" -OutFile $tessdataLicense
  Assert-Hash $tessdataLicense 'SHA256' $tessdataLicenseSha256
  $dependencyLicenses = Get-ChildItem -LiteralPath $vcpkgInstalled -Recurse -File -Filter 'copyright'
  foreach ($copyright in $dependencyLicenses) {
    $packageName = (Split-Path -Leaf (Split-Path -Parent $copyright.FullName)).ToLowerInvariant()
    if ($packageName -notmatch '^[a-z0-9+.-]+$') { throw "Unexpected vcpkg license package name: $packageName" }
    $destination = Join-Path $licenseRoot "$packageName.txt"
    if (Test-Path -LiteralPath $destination) {
      if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copyright.FullName -Algorithm SHA256).Hash) {
        throw "Conflicting vcpkg license texts for $packageName"
      }
    } else {
      Copy-Item -LiteralPath $copyright.FullName -Destination $destination
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $licenseRoot 'leptonica.txt') -PathType Leaf)) { throw 'Leptonica license is missing from the built runtime.' }

  $tesseractPath = Join-Path $outputRoot 'tesseract.exe'
  $tesseractSha256 = (Get-FileHash -LiteralPath $tesseractPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $originalPath = $env:Path
  try {
    $env:Path = "$(Join-Path $env:SystemRoot 'System32');$env:SystemRoot"
    $isolatedVersion = (& $tesseractPath --version 2>&1 | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $isolatedVersion -notmatch '^tesseract 5\.5\.3(?:\s|$)') { throw 'Built runtime is not self-contained outside the build environment.' }
    $languages = & $tesseractPath --tessdata-dir (Join-Path $outputRoot 'tessdata') --list-langs 2>&1
    if ($LASTEXITCODE -ne 0 -or $languages -notcontains 'eng' -or $languages -notcontains 'jpn') { throw 'Built runtime cannot load the pinned eng and jpn models.' }
  } finally {
    $env:Path = $originalPath
  }

  $buildManifest = @(
    'contractVersion=1'
    'tesseractVersion=5.5.3'
    "tesseractSourceTagObject=$tesseractTagObject"
    "tesseractSourceCommit=$tesseractCommit"
    "tesseractSourceSha512=$tesseractSourceSha512"
    "vcpkgBaseline=$vcpkgBaseline"
    'vcpkgTriplet=x64-windows-static'
    "tessdataCommit=$tessdataCommit"
    "tesseractSha256=$tesseractSha256"
    "jpnSha256=$japaneseSha256"
    "engSha256=$englishSha256"
    "tessdataLicenseSha256=$tessdataLicenseSha256"
  ) -join "`n"
  Set-Content -LiteralPath (Join-Path $outputRoot 'techmap-ocr-build.manifest') -Value $buildManifest -Encoding ascii -NoNewline
  Write-Output "Built pinned Tesseract 5.5.3 runtime: $outputRoot"
} finally {
  $resolvedWorkRoot = [System.IO.Path]::GetFullPath($workRoot)
  if ($resolvedWorkRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedWorkRoot).StartsWith('techmap-tesseract-build-')) {
    Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
