# Manage only KinKeep's Docker Compose project. Archive data is never removed.
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command
)

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot
$ProjectName = 'kinexport-local'
$EnvFile = Join-Path $ProjectDir '.env'
$ComposeFile = Join-Path $ProjectDir 'docker-compose.yml'
$DockerCommand = $null

function Show-Usage {
  @'
KinKeep local archive

Usage: .\setup.ps1 [command]
  start       Set up and start the archive (builds its image)
  status      Show project containers and health
  stop        Stop the archive, keeping its data
  restart     Restart the archive
  update      Rebuild and start with the current project files
  reinstall   Rebuild and recreate the app container, keeping its data
  logs        Follow archive server logs
  help        Show this help

Run without a command for the interactive menu.
'@ | Write-Output
}

function Test-Docker {
  $docker = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $docker) { throw 'Docker was not found. Install Docker Desktop and try again.' }
  $script:DockerCommand = $docker.Source
  & $DockerCommand compose version 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required (docker compose).' }
  & $DockerCommand info 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot reach the Docker daemon. Start Docker Desktop and try again.' }
}

function Test-ProjectOwnership {
  # Do not manage unrelated containers that happen to use this project name.
  $ids = @(& $DockerCommand ps -aq --filter "label=com.docker.compose.project=$ProjectName")
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker containers.' }
  foreach ($id in $ids) {
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    $json = & $DockerCommand inspect --format '{{json .Config.Labels}}' $id
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker container labels.' }
    $labels = $json | ConvertFrom-Json
    if ($null -eq $labels -or $labels.'io.kinexport.managed' -ne 'true') {
      throw "A container in Compose project '$ProjectName' is not marked as KinKeep-managed. Refusing to change it."
    }
  }
}

function Protect-EnvFile {
  try {
    $acl = Get-Acl -LiteralPath $EnvFile
    $acl.SetAccessRuleProtection($true, $false)
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $EnvFile -AclObject $acl
  } catch {
    Write-Warning "Could not restrict permissions on $EnvFile. Check the file's permissions."
  }
}

function Initialize-EnvFile {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    try {
      # CreateNew prevents overwriting an existing configuration, including in a race.
      $stream = [System.IO.File]::Open($EnvFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try {
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
        try { $writer.Write("KINEXPORT_TOKEN=$token`n") } finally { $writer.Dispose() }
      } finally { $stream.Dispose() }
    } catch {
      throw "Could not create $EnvFile; check its permissions or use the existing file."
    }
    Protect-EnvFile
    Write-Output "Created archive credentials in $EnvFile"
  }
  $valid = @(Get-Content -LiteralPath $EnvFile | Where-Object { $_ -cmatch '^KINEXPORT_TOKEN=.+' })
  if ($valid.Count -eq 0) { throw "Set a nonempty KINEXPORT_TOKEN in $EnvFile before continuing." }
}

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  # Compose otherwise gives an inherited shell variable precedence over .env.
  $previous = [Environment]::GetEnvironmentVariable('KINEXPORT_TOKEN', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('KINEXPORT_TOKEN', $null, 'Process')
    & $DockerCommand compose --project-name $ProjectName --env-file $EnvFile -f $ComposeFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed (exit $LASTEXITCODE)." }
  } finally {
    [Environment]::SetEnvironmentVariable('KINEXPORT_TOKEN', $previous, 'Process')
  }
}

function Show-Status {
  Write-Output 'KinKeep containers:'
  & $DockerCommand ps -a --filter "label=com.docker.compose.project=$ProjectName" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read Docker container status.' }
  Write-Output "`nArchive URL: http://127.0.0.1:8765"
}

function Invoke-Action([string]$Action) {
  $actionName = $Action.ToLowerInvariant()
  if ($actionName -in @('help', '-h', '--help')) { Show-Usage; return }
  if ($actionName -notin @('start', 'status', 'stop', 'restart', 'update', 'reinstall', 'logs')) {
    throw "Unknown command: $Action. Run .\setup.ps1 help for usage."
  }
  Test-Docker
  Test-ProjectOwnership
  if ($actionName -eq 'status') { Show-Status; return }
  if ($actionName -in @('stop', 'logs')) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Configuration $EnvFile is missing; no changes made." }
  } else {
    Initialize-EnvFile
  }
  switch ($actionName) {
    'start'     { Invoke-Compose -ComposeArgs @('up', '-d', '--build') }
    'stop'      { Invoke-Compose -ComposeArgs @('stop') }
    'restart'   { Invoke-Compose -ComposeArgs @('up', '-d'); Invoke-Compose -ComposeArgs @('restart') }
    'update'    { Invoke-Compose -ComposeArgs @('up', '-d', '--build') }
    'reinstall' { Invoke-Compose -ComposeArgs @('up', '-d', '--build', '--force-recreate') }
    'logs'      { Invoke-Compose -ComposeArgs @('logs', '-f') }
  }
  if ($actionName -notin @('logs', 'stop')) {
    Write-Output "`nArchive: http://127.0.0.1:8765`nCredentials: $EnvFile"
    Write-Output 'Copy the KINEXPORT_TOKEN value into the extension settings. Keep it private.'
  }
}

try {
  if ($args.Count -gt 0) { throw 'Only one command may be provided. Run .\setup.ps1 help for usage.' }
  if ($Command) { Invoke-Action $Command; exit 0 }
  if ([Console]::IsInputRedirected) { Show-Usage; exit 0 }
  Invoke-Action 'status'
  while ($true) {
    Write-Output "`nKinKeep archive`n1) Start / set up`n2) Status`n3) Stop`n4) Restart`n5) Update`n6) Reinstall (preserves data)`n7) View logs`n0) Exit"
    $choice = Read-Host 'Choose an option'
    switch ($choice) {
      '1' { Invoke-Action 'start' }
      '2' { Invoke-Action 'status' }
      '3' { Invoke-Action 'stop' }
      '4' { Invoke-Action 'restart' }
      '5' { Invoke-Action 'update' }
      '6' { Invoke-Action 'reinstall' }
      '7' { Invoke-Action 'logs' }
      { $_ -in @('0', 'q', 'Q') } { exit 0 }
      default { Write-Output 'Choose a listed option.' }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
