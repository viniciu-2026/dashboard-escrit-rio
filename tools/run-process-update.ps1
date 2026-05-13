Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$preflightPath = Join-Path $PSScriptRoot "automation-preflight.ps1"
$runStartedAt = (Get-Date).ToString("s")

if (-not (Test-Path -LiteralPath $preflightPath)) {
    throw "Preflight nao encontrado em $preflightPath"
}

$preflightJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $preflightPath
$preflight = $preflightJson | ConvertFrom-Json

if (-not $preflight.maxVerificationPtBr) {
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
    if ($blocker -match "TRIBUNAL_BROWSER_WS|TRIBUNAL_PROFILE_DIR|sessao autenticada") {
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
            "ou TRIBUNAL_PROFILE_DIR apontando para perfil persistente preparado no servidor"
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
