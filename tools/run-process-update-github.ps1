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

if (-not (Test-Path -LiteralPath $runnerPath)) {
    throw "Runner local nao encontrado em $runnerPath"
}
if (-not (Test-Path -LiteralPath $nodeRunnerPath)) {
    throw "Runner GitHub nao encontrado em $nodeRunnerPath"
}

$startedAt = (Get-Date).ToString("s")
$powershellExe = Get-PowerShellExecutable
$preflightText = & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $runnerPath 2>&1
$preflightExit = $LASTEXITCODE
$preflightJoined = ($preflightText | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
$preflightReportPath = Join-Path $reportDir "preflight.json"
$preflightJoined | Set-Content -LiteralPath $preflightReportPath -Encoding UTF8

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

$nodeOutput = & node $nodeRunnerPath --report-dir $reportDir 2>&1
$nodeExit = $LASTEXITCODE
$nodeJoined = ($nodeOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
$nodeJoined | Set-Content -LiteralPath (Join-Path $reportDir "node-output.txt") -Encoding UTF8

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
