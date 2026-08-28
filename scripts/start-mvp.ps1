param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $PSScriptRoot 'preflight-mvp.ps1')

$nodePath = (Get-Command node -ErrorAction Stop).Source
$webCli = Join-Path $repositoryRoot 'app\node_modules\vinext\dist\cli.js'
$standaloneServer = Join-Path $repositoryRoot 'app\dist\standalone\server.js'
$companionEntry = Join-Path $repositoryRoot 'companion\local-transcription-host.mjs'
$randomBytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
$launchSecret = ([System.BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()
[Array]::Clear($randomBytes, 0, $randomBytes.Length)

function Start-OwnedProcess([string]$WorkingDirectory, [string[]]$Arguments, [hashtable]$Environment) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $nodePath
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $false
  $quotedArguments = $Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
  $start.Arguments = $quotedArguments -join ' '
  foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[$key] = $Environment[$key] }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Failed to start an owned TechMap process.' }
  return $process
}

function Wait-Loopback([int]$Port, [System.Diagnostics.Process]$Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) { throw "TechMap child process exited during startup with code $($Process.ExitCode)." }
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $client.Connect('127.0.0.1', $Port); return } catch { Start-Sleep -Milliseconds 200 } finally { $client.Dispose() }
  }
  throw "Timed out waiting for loopback port $Port."
}

function Stop-OwnedProcess([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}

function Set-WebLaunchSecret([string]$Secret) {
  $client = [System.Net.Http.HttpClient]::new()
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  try {
    while ([DateTime]::UtcNow -lt $deadline) {
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Put, 'http://127.0.0.1:3000/api/local-launch')
      [void]$request.Headers.TryAddWithoutValidation('Origin', 'http://127.0.0.1:3000')
      $request.Content = [System.Net.Http.StringContent]::new((ConvertTo-Json @{ launchSecret = $Secret } -Compress), [System.Text.Encoding]::UTF8, 'application/json')
      $request.Content.Headers.ContentType.CharSet = $null
      try {
        try { $response = $client.SendAsync($request).GetAwaiter().GetResult() }
        catch {
          if ([DateTime]::UtcNow -ge $deadline) { throw }
          Start-Sleep -Milliseconds 200
          continue
        }
        try {
          if ($response.IsSuccessStatusCode) { return }
          if ([int]$response.StatusCode -notin @(404, 503)) { throw "UI launch-secret provisioning failed with status $([int]$response.StatusCode)." }
        } finally { $response.Dispose() }
      } finally { $request.Dispose() }
      Start-Sleep -Milliseconds 200
    }
    throw 'Timed out waiting for the UI launch-secret route.'
  } finally { $client.Dispose() }
}

$companion = $null
$web = $null
try {
  $companion = Start-OwnedProcess $repositoryRoot @($companionEntry) @{
    TECHMAP_LAUNCH_SECRET = $launchSecret
  }
  if (Test-Path -LiteralPath $standaloneServer -PathType Leaf) {
    $web = Start-OwnedProcess (Split-Path -Parent $standaloneServer) @($standaloneServer) @{
      HOST = '127.0.0.1'
      PORT = '3000'
    }
  } else {
    $web = Start-OwnedProcess (Join-Path $repositoryRoot 'app') @($webCli, 'start', '--hostname', '127.0.0.1', '--port', '3000') @{}
  }
  Wait-Loopback 43117 $companion
  Wait-Loopback 3000 $web
  Set-WebLaunchSecret $launchSecret
  if (-not $NoBrowser -and $env:TECHMAP_NO_BROWSER -ne '1') { Start-Process 'http://127.0.0.1:3000/' }
  $launchSecret = $null
  Write-Output 'TechMap Live is running locally. Press Ctrl+C in this window to stop every owned process.'
  while (-not $companion.HasExited -and -not $web.HasExited) { Start-Sleep -Milliseconds 500 }
  throw 'A TechMap child process exited. The remaining owned processes will be stopped.'
} finally {
  $launchSecret = $null
  Stop-OwnedProcess $web
  Stop-OwnedProcess $companion
}
