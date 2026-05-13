Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path $repoRoot "automation-report"
$runnerPath = Join-Path $PSScriptRoot "run-process-update.ps1"
$nodeRunnerPath = Join-Path $PSScriptRoot "github-process-update.mjs"

New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

function Write-JsonFile {
    param($Object, [string]$Path, [int]$Depth = 12)
    $Object | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Remove-SensitiveSamples {
    param($Object)
    if ($null -eq $Object) { return $Object }

    $copy = $Object | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $stack = New-Object System.Collections.Stack
    $stack.Push($copy)

    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        if ($null -eq $current) { continue }

        if ($current -is [System.Array]) {
            foreach ($item in $current) { $stack.Push($item) }
            continue
        }

        foreach ($property in @($current.PSObject.Properties)) {
            if ($property.Name -eq "sample") {
                $current.PSObject.Properties.Remove($property.Name)
            } elseif ($null -ne $property.Value) {
                $value = $property.Value
                if ($value -is [System.Array] -or ($value -isnot [string] -and $value.GetType().IsPrimitive -eq $false)) {
                    $stack.Push($value)
                }
            }
        }
    }

    return $copy
}

function Get-PowerShellExecutable {
    foreach ($candidate in @("pwsh", "powershell")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    throw "Nenhum executavel PowerShell encontrado no ambiente."
}

function Invoke-ProcessWithTimeout {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [int]$TimeoutSeconds,
        [string]$Name,
        [string]$OutputPath
    )

    $errorPath = "$OutputPath.err"
    Remove-Item -LiteralPath $OutputPath, $errorPath -Force -ErrorAction SilentlyContinue

    Write-Host "Iniciando $Name..."
    $job = Start-Job -ScriptBlock {
        param([string]$InnerFilePath, [string[]]$InnerArgumentList)
        $output = & $InnerFilePath @InnerArgumentList 2>&1
        [pscustomobject]@{
            exitCode = $LASTEXITCODE
            output = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        }
    } -ArgumentList $FilePath, $ArgumentList

    $finishedJob = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $finishedJob) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        throw "$Name excedeu timeout de $TimeoutSeconds segundos."
    }

    $jobResult = Receive-Job -Job $job
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $combined = if ($jobResult) { [string]$jobResult.output } else { "" }
    $combined | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    "" | Set-Content -LiteralPath $errorPath -Encoding UTF8

    return [pscustomobject]@{
        exitCode = if ($jobResult) { $jobResult.exitCode } else { $null }
        output = $combined
    }
}

if (-not (Test-Path -LiteralPath $runnerPath)) {
    throw "Runner local nao encontrado em $runnerPath"
}
if (-not (Test-Path -LiteralPath $nodeRunnerPath)) {
    throw "Runner GitHub nao encontrado em $nodeRunnerPath"
}

$startedAt = (Get-Date).ToString("s")
$powershellExe = Get-PowerShellExecutable
$preflightRun = Invoke-ProcessWithTimeout -FilePath $powershellExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runnerPath) -TimeoutSeconds 180 -Name "preflight" -OutputPath (Join-Path $reportDir "preflight-output.txt")
$preflightExit = $preflightRun.exitCode
$preflightJoined = $preflightRun.output
$preflightReportPath = Join-Path $reportDir "preflight.json"
$preflightJoined | Set-Content -LiteralPath $preflightReportPath -Encoding UTF8
Write-Host "Preflight finalizado com codigo $preflightExit."

try {
    $preflight = $preflightJoined | ConvertFrom-Json
} catch {
    $result = [pscustomobject]@{
        ok = $false
        status = "blocked"
        startedAt = $startedAt
        finishedAt = (Get-Date).ToString("s")
        reason = "Preflight nao retornou JSON valido."
        preflightExitCode = $preflightExit
        preflightOutput = $preflightJoined
    }
    Write-JsonFile -Object $result -Path (Join-Path $reportDir "github-run.json")
    Remove-SensitiveSamples -Object $result | ConvertTo-Json -Depth 12
    exit 2
}

if (-not $preflight.ok) {
    $result = [pscustomobject]@{
        ok = $false
        status = $preflight.status
        startedAt = $startedAt
        finishedAt = (Get-Date).ToString("s")
        reason = "Preflight bloqueou a execucao antes do navegador."
        preflight = $preflight
    }
    Write-JsonFile -Object $result -Path (Join-Path $reportDir "github-run.json")
    Remove-SensitiveSamples -Object $result | ConvertTo-Json -Depth 12
    exit 2
}

$nodeRun = Invoke-ProcessWithTimeout -FilePath "node" -ArgumentList @($nodeRunnerPath, "--report-dir", $reportDir) -TimeoutSeconds 180 -Name "runner Node/Playwright" -OutputPath (Join-Path $reportDir "node-output.txt")
$nodeExit = $nodeRun.exitCode
$nodeJoined = $nodeRun.output
$nodeJoined | Set-Content -LiteralPath (Join-Path $reportDir "node-output.txt") -Encoding UTF8
Write-Host "Runner Node/Playwright finalizado com codigo $nodeExit."

try {
    $nodeReport = $nodeJoined | ConvertFrom-Json
} catch {
    $nodeReport = [pscustomobject]@{
        ok = $false
        status = "blocked"
        reason = "Runner Node nao retornou JSON valido."
        output = $nodeJoined
    }
}

$result = [pscustomobject]@{
    ok = ($nodeExit -eq 0 -and $nodeReport.ok)
    status = $nodeReport.status
    startedAt = $startedAt
    finishedAt = (Get-Date).ToString("s")
    preflight = $preflight
    node = $nodeReport
}

Write-JsonFile -Object $result -Path (Join-Path $reportDir "github-run.json")
Remove-SensitiveSamples -Object $result | ConvertTo-Json -Depth 12

if (-not $result.ok) {
    exit 2
}
