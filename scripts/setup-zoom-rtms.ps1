$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot '..\native\privacy\build\Release\techmap-privacy.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
  throw 'Build native/privacy before configuring Zoom RTMS credentials.'
}

try {
  & $helper store-zoom-client-id
  if ($LASTEXITCODE -ne 0) { throw 'Zoom Client ID was rejected.' }
  & $helper store-zoom-client-secret
  if ($LASTEXITCODE -ne 0) { throw 'Zoom Client Secret was rejected.' }
  & $helper store-zoom-webhook-secret
  if ($LASTEXITCODE -ne 0) { throw 'Zoom Webhook Secret Token was rejected.' }
  & $helper zoom-credentials-status
  if ($LASTEXITCODE -ne 0) { throw 'Zoom RTMS credential status could not be verified.' }
} catch {
  & $helper delete-zoom-credentials 2>$null | Out-Null
  throw
}

Write-Output 'Stored Zoom RTMS credentials under TechMapLive/* in Windows Credential Manager.'
Write-Output 'No Zoom credential was written to the repository, environment, command line, or application log.'
