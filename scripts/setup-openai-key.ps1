$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot '..\native\privacy\build\Release\techmap-privacy.exe'
if (-not (Test-Path -LiteralPath $helper)) {
  throw 'Build native/privacy before configuring the OpenAI API key.'
}

& $helper store-key
if ($LASTEXITCODE -ne 0) { throw 'Windows Credential Manager did not accept the API key.' }
Write-Output 'Stored the OpenAI API key as TechMapLive/OpenAIApiKey in Windows Credential Manager.'
