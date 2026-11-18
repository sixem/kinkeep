# Exercise setup.ps1 against a temporary fake Docker executable, never the daemon.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$temporaryParent = if ($env:KINEXPORT_TEST_TMPDIR) { $env:KINEXPORT_TEST_TMPDIR } else { [IO.Path]::GetTempPath() }
$fixture = Join-Path $temporaryParent ('KinKeep Setup Test ' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $fixture 'fake docker bin'
$log = Join-Path $fixture 'docker calls.log'
$setup = Join-Path $fixture 'setup.ps1'
$envFile = Join-Path $fixture '.env'
$composeFile = Join-Path $fixture 'docker-compose.yml'
$sentinel = Join-Path $fixture 'archive.sqlite'
$shell = (Get-Process -Id $PID).Path

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-TestSetup([string]$Action, [string]$Mode = '', [bool]$MissingDocker = $false) {
  if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $shell
  $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$setup`" $Action"
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['PATH'] = if ($MissingDocker) { Join-Path $fixture 'empty path' } else { "$bin;$env:PATH" }
  $start.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
  $start.EnvironmentVariables['KINEXPORT_TEST_LOG'] = $log
  $start.EnvironmentVariables['KINEXPORT_TEST_MODE'] = $Mode
  $start.EnvironmentVariables['KINEXPORT_TOKEN'] = 'inherited-test-token'
  $process = [Diagnostics.Process]::Start($start)
  try {
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $calls = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log) } else { @() }
    return [PSCustomObject]@{ Code = $process.ExitCode; Output = $stdout + $stderr; Calls = $calls }
  } finally { $process.Dispose() }
}

try {
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $fixture 'empty path') | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot 'setup.ps1') -Destination $setup
  [IO.File]::WriteAllText($composeFile, 'services: {}')
  [IO.File]::WriteAllText($sentinel, 'synthetic archive must remain intact')

  $fakeDocker = @'
using System;
using System.IO;
public class FakeDocker {
  public static int Main(string[] args) {
    string log = Environment.GetEnvironmentVariable("KINEXPORT_TEST_LOG");
    string mode = Environment.GetEnvironmentVariable("KINEXPORT_TEST_MODE");
    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join("|", args) + "\n");
    if (args.Length == 0) return 1;
    if (args[0] == "compose" && args.Length > 1 && args[1] == "version") return mode == "version-fails" ? 1 : 0;
    if (args[0] == "info") return mode == "daemon-fails" ? 1 : 0;
    if (args[0] == "ps" && args.Length > 1 && args[1] == "-aq") {
      if (mode == "collision" || mode == "inspect-fails") Console.WriteLine("fixture-container");
      return 0;
    }
    if (args[0] == "ps") return 0;
    if (args[0] == "inspect") {
      if (mode == "inspect-fails") return 1;
      Console.WriteLine("{\"io.kinexport.managed\":\"false\"}");
      return 0;
    }
    if (args[0] == "compose") {
      if (Environment.GetEnvironmentVariable("KINEXPORT_TOKEN") != null) {
        if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, "TOKEN_WAS_INHERITED\n");
        return 9;
      }
      return mode == "compose-fails" ? 7 : 0;
    }
    return 1;
  }
}
'@
  $fakeExecutable = Join-Path $bin 'docker.exe'
  if ($PSVersionTable.PSVersion.Major -lt 7) {
    Add-Type -TypeDefinition $fakeDocker -Language CSharp -OutputAssembly $fakeExecutable -OutputType ConsoleApplication
  } else {
    # PowerShell 7.1+ cannot emit executables with Add-Type. Compile the fake
    # with Windows PowerShell, then exercise setup.ps1 with the current shell.
    $sourceFile = Join-Path $fixture 'fake docker.cs'
    $compilerScript = Join-Path $fixture 'compile fake docker.ps1'
    [IO.File]::WriteAllText($sourceFile, $fakeDocker)
    [IO.File]::WriteAllText($compilerScript, 'param($Source, $Destination); Add-Type -Path $Source -OutputAssembly $Destination -OutputType ConsoleApplication')
    $compiler = New-Object System.Diagnostics.ProcessStartInfo
    $compiler.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $compiler.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$compilerScript`" `"$sourceFile`" `"$fakeExecutable`""
    $compiler.UseShellExecute = $false
    $compiler.RedirectStandardOutput = $true
    $compiler.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($compiler)
    try {
      $null = $process.StandardOutput.ReadToEnd()
      $compilerError = $process.StandardError.ReadToEnd()
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw "Could not compile fake Docker: $compilerError" }
    } finally { $process.Dispose() }
  }

  $result = Invoke-TestSetup 'start'
  Assert-True ($result.Code -eq 0) 'First start should succeed.'
  Assert-True (Test-Path -LiteralPath $envFile -PathType Leaf) 'First start should create credentials.'
  $credentials = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($envFile))
  Assert-True ($credentials -cmatch '^KINEXPORT_TOKEN=[0-9a-f]{64}\n$') 'The generated token must be 32 random bytes in a BOM-free env file.'
  Assert-True (-not $result.Output.Contains($credentials.Trim().Substring('KINEXPORT_TOKEN='.Length))) 'The generated token must not be printed.'
  Assert-True (-not ($result.Calls -contains 'TOKEN_WAS_INHERITED')) 'An inherited token must not reach Compose.'
  $expectedPrefix = "compose|--project-name|kinkeep-local|--env-file|$envFile|-f|$composeFile"
  Assert-True ($result.Calls -contains "$expectedPrefix|up|-d|--build") 'Start must pass the correct Compose project, paths and flags.'

  $expected = @{
    status = @(); start = @('up|-d|--build'); update = @('up|-d|--build')
    restart = @('up|-d', 'restart'); reinstall = @('up|-d|--build|--force-recreate')
    stop = @('stop'); logs = @('logs|-f')
  }
  foreach ($action in @('status', 'start', 'update', 'restart', 'reinstall', 'stop', 'logs')) {
    $result = Invoke-TestSetup $action
    Assert-True ($result.Code -eq 0) "$action should succeed."
    Assert-True ([IO.File]::ReadAllText($envFile) -ceq $credentials) "$action must preserve existing credentials."
    Assert-True ([IO.File]::ReadAllText($sentinel) -ceq 'synthetic archive must remain intact') "$action must preserve archive files."
    Assert-True (-not ($result.Calls -contains 'TOKEN_WAS_INHERITED')) "$action must not pass the inherited token to Compose."
    foreach ($argsLine in $expected[$action]) {
      Assert-True ($result.Calls -contains "$expectedPrefix|$argsLine") "$action did not pass the expected Compose arguments."
    }
    if ($action -eq 'status') { Assert-True (-not ($result.Calls -match '^compose\|--project-name\|')) 'Status must not modify the project.' }
  }

  foreach ($mode in @('collision', 'inspect-fails', 'version-fails', 'daemon-fails', 'compose-fails')) {
    $result = Invoke-TestSetup 'start' $mode
    Assert-True ($result.Code -ne 0) "$mode must fail."
    Assert-True ([IO.File]::ReadAllText($envFile) -ceq $credentials) "$mode must preserve credentials."
    Assert-True ([IO.File]::ReadAllText($sentinel) -ceq 'synthetic archive must remain intact') "$mode must preserve archive files."
    if ($mode -in @('collision', 'inspect-fails', 'version-fails', 'daemon-fails')) {
      Assert-True (-not ($result.Calls -match '^compose\|--project-name\|')) "$mode must not change the Compose project."
    }
  }

  $result = Invoke-TestSetup 'start' '' $true
  Assert-True ($result.Code -ne 0) 'Missing Docker must fail.'
  Assert-True ([IO.File]::ReadAllText($envFile) -ceq $credentials) 'Missing Docker must preserve credentials.'
  $result = Invoke-TestSetup 'help' '' $true
  Assert-True ($result.Code -eq 0) 'Help must work without Docker.'
  $result = Invoke-TestSetup 'invalid-command' '' $true
  Assert-True ($result.Code -ne 0) 'An unknown command must fail.'
  [IO.File]::WriteAllText($envFile, "KINEXPORT_TOKEN=`n")
  $result = Invoke-TestSetup 'start'
  Assert-True ($result.Code -ne 0) 'Empty existing credentials must be rejected.'
  Assert-True ([IO.File]::ReadAllText($envFile) -ceq "KINEXPORT_TOKEN=`n") 'Invalid existing credentials must not be overwritten.'
  Assert-True (-not ($result.Calls -match '^compose\|--project-name\|')) 'Invalid credentials must not change the Compose project.'
  Remove-Item -LiteralPath $envFile
  foreach ($action in @('stop', 'logs')) {
    $result = Invoke-TestSetup $action
    Assert-True ($result.Code -ne 0) "$action without .env must fail."
    Assert-True (-not (Test-Path -LiteralPath $envFile)) "$action must not generate credentials."
    Assert-True (-not ($result.Calls -match '^compose\|--project-name\|')) "$action must not change the Compose project."
  }
  Write-Output 'Windows setup tests passed with isolated fake Docker.'
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
