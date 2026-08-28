$ErrorActionPreference = 'Stop'

$preflight = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'preflight-mvp.ps1')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("techmap-node-guidance-$([Guid]::NewGuid().ToString('N'))")
$system32 = Join-Path $env:SystemRoot 'System32'
[void](New-Item -ItemType Directory -Path $testRoot)

function Assert-NodeFailure([string]$PathValue, [string[]]$ExpectedText) {
  $previousPath = $env:Path
  $failed = $false
  $message = ''
  try {
    $env:Path = $PathValue
    try { & $preflight } catch { $failed = $true; $message = $_.Exception.Message }
  } finally {
    $env:Path = $previousPath
  }
  if (-not $failed) { throw 'Node.js preflight fixture unexpectedly passed.' }
  foreach ($text in @($ExpectedText + @('Node.js 22.18 or later', 'winget install --id OpenJS.NodeJS.LTS --exact', 'close this PowerShell window, open a new one'))) {
    if (-not $message.Contains($text)) { throw "Node.js preflight guidance is missing: $text" }
  }
}

try {
  Assert-NodeFailure "$testRoot;$system32" @('Node.js was not found on PATH.')

  Set-Content -LiteralPath (Join-Path $testRoot 'node.cmd') -Encoding Ascii -Value '@exit /b 1'
  Assert-NodeFailure "$testRoot;$system32" @('Node.js version could not be verified:')

  Set-Content -LiteralPath (Join-Path $testRoot 'node.cmd') -Encoding Ascii -Value @('@echo v20.0.0', '@exit /b 0')
  Assert-NodeFailure "$testRoot;$system32" @('installed Node.js version is unsupported: v20.0.0')
  Write-Output 'Node.js preflight recovery guidance: PASS'
} finally {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
