[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-RuntimeRoot {
  if ($env:LOCALAPPDATA) {
    return Join-Path $env:LOCALAPPDATA 'VoiceOverlayAssistant\runtime'
  }
  return Join-Path $HOME '.voice-overlay-assistant\runtime'
}

function Write-WatchdogLog {
  param(
    [string]$Level,
    [string]$Message,
    [hashtable]$Context = @{}
  )

  $runtimeRoot = Get-RuntimeRoot
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $logPath = Join-Path $runtimeRoot 'openclaw-gateway-watchdog.log'
  $entry = @{
    timestamp = (Get-Date).ToString('o')
    level = $Level
    message = $Message
    context = $Context
  } | ConvertTo-Json -Depth 6 -Compress
  Add-Content -LiteralPath $logPath -Value $entry
}

function Invoke-OpenClaw {
  param(
    [string[]]$Arguments
  )

  $command = Get-Command openclaw -ErrorAction SilentlyContinue
  if (-not $command) {
    throw 'OpenClaw is not installed or not available on PATH.'
  }

  $output = & $command.Source @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  return @{
    ExitCode = $exitCode
    Output = $output.Trim()
  }
}

function Get-GatewayStatus {
  $result = Invoke-OpenClaw -Arguments @('gateway', 'status', '--json', '--no-probe')
  if ($result.ExitCode -ne 0) {
    return @{
      ok = $false
      raw = $result.Output
      parsed = $null
    }
  }

  try {
    return @{
      ok = $true
      raw = $result.Output
      parsed = ($result.Output | ConvertFrom-Json)
    }
  } catch {
    return @{
      ok = $false
      raw = $result.Output
      parsed = $null
    }
  }
}

function Get-GatewayProcesses {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'node_modules\\openclaw\\dist\\(entry|index)\.js gateway' -or
    $_.CommandLine -match '\\.openclaw\\gateway\.cmd'
  })
}

function Test-GatewayDashboard {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18790/' -UseBasicParsing -TimeoutSec 5
    return @{
      ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
      statusCode = $response.StatusCode
      statusDescription = $response.StatusDescription
    }
  } catch {
    return @{
      ok = $false
      statusCode = $null
      statusDescription = $_.Exception.Message
    }
  }
}

function Get-GatewaySnapshot {
  $status = Get-GatewayStatus
  $processes = Get-GatewayProcesses
  $dashboard = Test-GatewayDashboard
  $serviceLoaded = $false

  if ($status.ok -and $status.parsed) {
    $serviceLoaded = ($status.parsed.service.loaded -eq $true)
  }

  return @{
    status = $status
    processes = $processes
    processCount = $processes.Count
    dashboard = $dashboard
    serviceLoaded = $serviceLoaded
    rpcChecked = $false
  }
}

function Test-GatewayHealthy {
  param(
    $Snapshot
  )

  return ($Snapshot.processCount -gt 0) -and ($Snapshot.dashboard.ok -eq $true)
}

function Stop-GatewayProcessHard {
  $processes = Get-GatewayProcesses

  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-WatchdogLog -Level 'warn' -Message 'Killed stale OpenClaw gateway process.' -Context @{
        processId = $process.ProcessId
        commandLine = $process.CommandLine
      }
    } catch {
      Write-WatchdogLog -Level 'error' -Message 'Failed to kill stale OpenClaw gateway process.' -Context @{
        processId = $process.ProcessId
        commandLine = $process.CommandLine
        error = $_.Exception.Message
      }
    }
  }
}

function Invoke-ScheduledTask {
  param(
    [string[]]$Arguments
  )

  $output = & schtasks @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  return @{
    ExitCode = $exitCode
    Output = $output.Trim()
  }
}

function Restart-GatewayService {
  $stop = Invoke-ScheduledTask -Arguments @('/End', '/TN', 'OpenClaw Gateway')
  Write-WatchdogLog -Level 'warn' -Message 'Requested OpenClaw gateway scheduled-task stop.' -Context @{
    exitCode = $stop.ExitCode
    output = $stop.Output
  }

  Start-Sleep -Seconds 2
  Stop-GatewayProcessHard

  $start = Invoke-ScheduledTask -Arguments @('/Run', '/TN', 'OpenClaw Gateway')
  Write-WatchdogLog -Level 'info' -Message 'Requested OpenClaw gateway scheduled-task start.' -Context @{
    exitCode = $start.ExitCode
    output = $start.Output
  }
}

try {
  $before = Get-GatewaySnapshot
  if (Test-GatewayHealthy -Snapshot $before) {
    Write-WatchdogLog -Level 'info' -Message 'Gateway service check passed.' -Context @{
      processCount = $before.processCount
      dashboardOk = $before.dashboard.ok
      dashboardStatus = $before.dashboard.statusCode
      rpcChecked = $before.rpcChecked
      serviceLoaded = $before.serviceLoaded
    }
    exit 0
  }

  Write-WatchdogLog -Level 'warn' -Message 'Gateway health check failed. Starting repair.' -Context @{
    processCount = $before.processCount
    dashboardOk = $before.dashboard.ok
    dashboardStatus = $before.dashboard.statusCode
    rpcChecked = $before.rpcChecked
    statusOk = $before.status.ok
    raw = $before.status.raw
  }

  Restart-GatewayService
  Start-Sleep -Seconds 12

  $afterSoftRestart = Get-GatewaySnapshot
  if (Test-GatewayHealthy -Snapshot $afterSoftRestart) {
    Write-WatchdogLog -Level 'info' -Message 'Gateway recovered after restart.' -Context @{
      processCount = $afterSoftRestart.processCount
      dashboardOk = $afterSoftRestart.dashboard.ok
      dashboardStatus = $afterSoftRestart.dashboard.statusCode
      rpcChecked = $afterSoftRestart.rpcChecked
    }
    exit 0
  }

  Restart-GatewayService
  Start-Sleep -Seconds 15

  $afterHardRestart = Get-GatewaySnapshot
  if (Test-GatewayHealthy -Snapshot $afterHardRestart) {
    Write-WatchdogLog -Level 'info' -Message 'Gateway recovered after hard restart.' -Context @{
      processCount = $afterHardRestart.processCount
      dashboardOk = $afterHardRestart.dashboard.ok
      dashboardStatus = $afterHardRestart.dashboard.statusCode
      rpcChecked = $afterHardRestart.rpcChecked
    }
    exit 0
  }

  Write-WatchdogLog -Level 'error' -Message 'Gateway is still unhealthy after repair attempts.' -Context @{
    processCount = $afterHardRestart.processCount
    dashboardOk = $afterHardRestart.dashboard.ok
    dashboardStatus = $afterHardRestart.dashboard.statusCode
    rpcChecked = $afterHardRestart.rpcChecked
    raw = $afterHardRestart.status.raw
  }
  exit 1
} catch {
  Write-WatchdogLog -Level 'error' -Message 'Watchdog execution failed.' -Context @{
    error = $_.Exception.Message
  }
  exit 1
}
