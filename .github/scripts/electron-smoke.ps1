param()

$ErrorActionPreference = "Stop"

$LogBase = if ($env:SMOKE_LOG) { $env:SMOKE_LOG } else { [System.IO.Path]::GetTempFileName() }
$StdoutLog = "$LogBase.out"
$StderrLog = "$LogBase.err"
$TimeoutSecs = if ($env:SMOKE_TIMEOUT) { [int]$env:SMOKE_TIMEOUT } else { 90 }
$Process = $null

function Get-SmokeLog {
  $parts = @()
  if (Test-Path $StdoutLog) { $parts += Get-Content -Raw -Path $StdoutLog }
  if (Test-Path $StderrLog) { $parts += Get-Content -Raw -Path $StderrLog }
  return ($parts -join "`n")
}

function Fail-Smoke {
  param([string]$Message)
  Write-Host "::error::$Message"
  Write-Host "--- smoke log ---"
  $text = Get-SmokeLog
  if ($text) { Write-Host $text } else { Write-Host "(no log captured)" }
  exit 1
}

try {
  if (-not $env:RELEASE_DIR) {
    Fail-Smoke "RELEASE_DIR not set"
  }

  if (-not (Test-Path -Path $env:RELEASE_DIR -PathType Container)) {
    Fail-Smoke "RELEASE_DIR=$env:RELEASE_DIR does not exist"
  }

  $UnpackedDir = Join-Path $env:RELEASE_DIR "win-unpacked"
  if (-not (Test-Path -Path $UnpackedDir -PathType Container)) {
    Fail-Smoke "Windows unpacked directory not found under $UnpackedDir"
  }

  $Binary = Get-ChildItem -Path $UnpackedDir -Filter "*.exe" -File |
    Sort-Object Name |
    Select-Object -First 1
  if (-not $Binary) {
    Fail-Smoke "Windows exe not found under $UnpackedDir"
  }

  Write-Host "Launching: $($Binary.FullName) --no-sandbox"
  Write-Host "Log: $LogBase"
  Write-Host "Timeout: ${TimeoutSecs}s"

  $Process = Start-Process `
    -FilePath $Binary.FullName `
    -ArgumentList "--no-sandbox" `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru

  $Deadline = (Get-Date).AddSeconds($TimeoutSecs)
  $Port = $null
  while ((Get-Date) -lt $Deadline) {
    $text = Get-SmokeLog
    $match = [regex]::Matches($text, "Server started on port (\d+)") | Select-Object -Last 1
    if ($match) {
      $Port = $match.Groups[1].Value
      break
    }

    if ($Process.HasExited) {
      Fail-Smoke "App process exited before starting the server (pid=$($Process.Id))"
    }

    Start-Sleep -Seconds 1
  }

  if (-not $Port) {
    Fail-Smoke "App did not log 'Server started on port N' within ${TimeoutSecs}s"
  }

  Write-Host "App reports server on port $Port"

  $HealthOk = $false
  for ($i = 1; $i -le 30; $i++) {
    try {
      $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5
      if ([int]$Response.StatusCode -ge 200 -and [int]$Response.StatusCode -lt 300) {
        $HealthOk = $true
        if ($i -gt 1) { Write-Host "Health probe succeeded after $i attempt(s)" }
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  if (-not $HealthOk) {
    Fail-Smoke "Health probe failed: GET http://127.0.0.1:$Port/health (gave up after 30s)"
  }

  Write-Host "Smoke OK on Windows"
} finally {
  if ($Process -and -not $Process.HasExited) {
    Write-Host "Stopping app (pid=$($Process.Id))"
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process "Codex Proxy" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
