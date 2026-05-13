Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$preflightPath = Join-Path $PSScriptRoot "automation-preflight.ps1"
$runStartedAt = (Get-Date).ToString("s")

if (-not (Test-Path -LiteralPath $preflightPath)) {
    throw "Preflight nao encontrado em $preflightPath"
}

function Test-JsonProperty {
    param($Object, [string]$Name)
    return ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name)
}

function Get-PowerShellExecutable {
    foreach ($candidate in @("pwsh", "powershell")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    throw "Nenhum executavel PowerShell encontrado no ambiente."
}

try {
    $powershellExe = Get-PowerShellExecutable
    $preflightOutput = & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $preflightPath 2>&1
    $preflightExit = $LASTEXITCODE
} catch {
    $preflightOutput = @($_.Exception.Message)
    $preflightExit = 1
}

$preflightText = ($preflightOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine

try {
    $preflight = $preflightText | ConvertFrom-Json
} catch {
    $result = [pscustomobject]@{
        ok = $false
        status = "blocked"
        startedAt = $runStartedAt
        finishedAt = (Get-Date).ToString("s")
        reason = "Preflight nao retornou JSON valido."
        preflightExitCode = $preflightExit
        preflightOutput = $preflightText
    }
    $result | ConvertTo-Json -Depth 8
    exit 2
}

if ((Test-JsonProperty -Object $preflight -Name "ok") -and -not $preflight.ok) {
    $result = [pscustomobject]@{
        ok = $false
        status = "blocked"
        startedAt = $runStartedAt
        finishedAt = (Get-Date).ToString("s")
        reason = "Preflight bloqueado antes da consulta processual."
        preflightExitCode = $preflightExit
        preflight = $preflight
    }
    $result | ConvertTo-Json -Depth 8
    exit 2
}

if (-not (Test-JsonProperty -Object $preflight -Name "maxVerificationPtBr") -or -not $preflight.maxVerificationPtBr) {
    $result = [pscustomobject]@{
        ok = $false
        status = "blocked"
        startedAt = $runStartedAt
        finishedAt = (Get-Date).ToString("s")
        reason = "Nao foi possivel determinar a ultima verificacao do dashboard/Firebase."
        preflight = $preflight
    }
    $result | ConvertTo-Json -Depth 8
    exit 2
}

$hardBlockers = @()
foreach ($blocker in @($preflight.blockers)) {
    if ($blocker -match "TRIBUNAL_BROWSER_WS|TRIBUNAL_PROFILE_DIR|sessao|GOVBR_CPF|GOVBR_PASSWORD") {
        $hardBlockers += $blocker
    }
}

if ($hardBlockers.Count -gt 0) {
    $result = [pscustomobject]@{
        ok = $false
        status = "teor-pendente"
        startedAt = $runStartedAt
        finishedAt = (Get-Date).ToString("s")
        period = [pscustomobject]@{
            from = $preflight.maxVerificationPtBr
            to = $preflight.todayPtBr
        }
        message = "Rotina interrompida antes de consultar tribunais: ambiente automatico sem navegador/perfil persistente autenticado."
        nextRequiredConfig = @(
            "TRIBUNAL_BROWSER_WS apontando para navegador remoto persistente autenticado",
            "ou TRIBUNAL_PROFILE_DIR apontando para perfil persistente preparado no servidor",
            "ou, no GitHub Actions, Secrets GOVBR_CPF/GOVBR_PASSWORD configurados"
        )
        preflight = $preflight
    }
    $result | ConvertTo-Json -Depth 8
    exit 2
}

$result = [pscustomobject]@{
    ok = $true
    status = "ready-for-tribunal-stage"
    startedAt = $runStartedAt
    finishedAt = (Get-Date).ToString("s")
    period = [pscustomobject]@{
        from = $preflight.maxVerificationPtBr
        to = $preflight.todayPtBr
    }
    message = "Preflight aprovado. Proxima etapa deve consultar jus.br/pushes e ler teor nos tribunais autenticados."
    preflight = $preflight
}

$result | ConvertTo-Json -Depth 8
