param(
  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

if ($env:OS -ne 'Windows_NT') { throw 'TechMap Live native helpers support Windows only.' }
foreach ($command in @('cmake', 'node', 'pnpm')) { [void](Get-Command $command -ErrorAction Stop) }

foreach ($nativeProject in @('privacy', 'teams-captions', 'windows-audio', 'transcription')) {
  $source = Join-Path $repositoryRoot "native\$nativeProject"
  $build = Join-Path $source 'build'
  & cmake -S $source -B $build -A x64
  if ($LASTEXITCODE -ne 0) { throw "CMake configure failed: $nativeProject" }
  & cmake --build $build --config Release
  if ($LASTEXITCODE -ne 0) { throw "CMake build failed: $nativeProject" }
  & ctest --test-dir $build -C Release --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw "Native tests failed: $nativeProject" }
}

Push-Location (Join-Path $repositoryRoot 'app')
try {
  if (-not $SkipDependencyInstall) {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
  foreach ($script in @('typecheck', 'test', 'lint', 'build')) {
    & pnpm run $script
    if ($LASTEXITCODE -ne 0) { throw "Web validation failed: $script" }
  }
} finally { Pop-Location }

& node (Join-Path $repositoryRoot 'scripts\scan-public-repo.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Public repository privacy scan failed.' }
Write-Output 'TechMap Live MVP build: PASS'
