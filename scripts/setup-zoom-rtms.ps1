$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot '..\native\privacy\build\Release\techmap-privacy.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
  throw 'Build native/privacy before configuring Zoom RTMS credentials.'
}

& $helper store-zoom-client-id
if ($LASTEXITCODE -ne 0) { throw 'Zoom Client ID was rejected. Existing other Zoom credentials were kept.' }
& $helper store-zoom-client-secret
if ($LASTEXITCODE -ne 0) { throw 'Zoom Client Secret was rejected. Existing other Zoom credentials were kept.' }
& $helper store-zoom-webhook-secret
if ($LASTEXITCODE -ne 0) { throw 'Zoom Webhook Secret Token was rejected. Existing other Zoom credentials were kept.' }
& $helper zoom-credentials-status
if ($LASTEXITCODE -ne 0) { throw 'Zoom RTMS credential status could not be verified.' }

Write-Output 'Stored Zoom RTMS credentials under TechMapLive/* in Windows Credential Manager.'
Write-Output 'No Zoom credential was written to the repository, environment, command line, or application log.'
