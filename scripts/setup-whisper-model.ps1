$ErrorActionPreference = 'Stop'

$modelUri = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
$expectedSha256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
$modelDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TechMapLive\models'
$modelPath = Join-Path $modelDirectory 'ggml-tiny.bin'
$temporaryPath = Join-Path $modelDirectory 'ggml-tiny.bin.download'

New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null
if (Test-Path -LiteralPath $modelPath) {
  $installedHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedHash -eq $expectedSha256) {
    Write-Output "Verified model already installed at $modelPath"
    exit 0
  }
  throw 'An existing model failed SHA-256 verification. Remove it explicitly before retrying.'
}

try {
  Invoke-WebRequest -Uri $modelUri -OutFile $temporaryPath -UseBasicParsing
  $downloadedHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadedHash -ne $expectedSha256) { throw 'Downloaded model failed SHA-256 verification.' }
  Move-Item -LiteralPath $temporaryPath -Destination $modelPath
  Write-Output "Installed verified model at $modelPath"
} finally {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
}
