Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$processesUrl = "https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes.json"
$cnjPattern = "\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b"

function ConvertTo-DatePtBr {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParseExact($Value, "dd/MM/yyyy", [Globalization.CultureInfo]::GetCultureInfo("pt-BR"), [Globalization.DateTimeStyles]::None, [ref]$parsed)) {
        return $parsed
    }
    return $null
}

function ConvertTo-ProcessList {
    param($Raw)
    if ($null -eq $Raw) { return @() }
    if ($Raw -is [System.Array]) { return @($Raw | Where-Object { $null -ne $_ }) }

    $items = @()
    foreach ($property in $Raw.PSObject.Properties) {
        if ($null -ne $property.Value) {
            $value = $property.Value
            if (-not ($value.PSObject.Properties.Name -contains "id")) {
                $value | Add-Member -NotePropertyName "id" -NotePropertyValue $property.Name -Force
            }
            $items += $value
        }
    }
    return $items
}

function Get-TextProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return "" }
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $value = $Object.$Name
        if ($null -ne $value) { return [string]$value }
    }
    return ""
}

$environment = [pscustomobject]@{
    hasTribunalBrowserWs = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_BROWSER_WS)
    hasTribunalProfileDir = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_PROFILE_DIR)
    hasGmailConnectorHint = -not [string]::IsNullOrWhiteSpace($env:GMAIL_CONNECTOR_AVAILABLE)
}

try {
    $raw = Invoke-RestMethod -Uri $processesUrl -Method Get -TimeoutSec 45
} catch {
    $result = [pscustomobject]@{
        ok = $false
        source = $processesUrl
        totalProcesses = 0
        eligibleCnjs = 0
        maxVerificationPtBr = $null
        maxVerificationIso = $null
        todayPtBr = (Get-Date).ToString("dd/MM/yyyy")
        environment = $environment
        blockers = @(
            "Nao foi possivel ler o dashboard/Firebase no endpoint publicado; sem isso nao ha periodo confiavel para a atualizacao."
            if (-not $environment.hasTribunalBrowserWs -and -not $environment.hasTribunalProfileDir) {
                "Ambiente automatico sem TRIBUNAL_BROWSER_WS ou TRIBUNAL_PROFILE_DIR; nao ha sessao autenticada de tribunal para leitura de teor."
            }
            if (-not $environment.hasGmailConnectorHint) {
                "Ambiente automatico sem indicio de conector Gmail disponivel; pushes podem ficar indisponiveis."
            }
        )
        error = $_.Exception.Message
    }
    $result | ConvertTo-Json -Depth 6
    exit 0
}

$processes = ConvertTo-ProcessList -Raw $raw

$maxVerification = $null
$eligible = @()

foreach ($process in $processes) {
    $verificationText = Get-TextProperty -Object $process -Name "ver"
    $verification = ConvertTo-DatePtBr -Value $verificationText
    if ($null -ne $verification -and ($null -eq $maxVerification -or $verification -gt $maxVerification)) {
        $maxVerification = $verification
    }

    $processText = Get-TextProperty -Object $process -Name "proc"
    $matches = [regex]::Matches($processText, $cnjPattern)
    foreach ($match in $matches) {
        $cnj = $match.Value
        if ($cnj -notmatch "\.5\.") {
            $eligible += [pscustomobject]@{
                id = Get-TextProperty -Object $process -Name "id"
                cliente = Get-TextProperty -Object $process -Name "cl"
                tipo = Get-TextProperty -Object $process -Name "tipo"
                cnj = $cnj
                ver = $verificationText
            }
        }
    }
}

$result = [pscustomobject]@{
    ok = $true
    source = $processesUrl
    totalProcesses = $processes.Count
    eligibleCnjs = $eligible.Count
    maxVerificationPtBr = if ($null -ne $maxVerification) { $maxVerification.ToString("dd/MM/yyyy") } else { $null }
    maxVerificationIso = if ($null -ne $maxVerification) { $maxVerification.ToString("yyyy-MM-dd") } else { $null }
    todayPtBr = (Get-Date).ToString("dd/MM/yyyy")
    environment = $environment
    blockers = @(
        if (-not $environment.hasTribunalBrowserWs -and -not $environment.hasTribunalProfileDir) {
            "Ambiente automatico sem TRIBUNAL_BROWSER_WS ou TRIBUNAL_PROFILE_DIR; nao ha sessao autenticada de tribunal para leitura de teor."
        }
        if (-not $environment.hasGmailConnectorHint) {
            "Ambiente automatico sem indicio de conector Gmail disponivel; pushes podem ficar indisponiveis."
        }
    )
    sample = @($eligible | Select-Object -First 10)
}

$result | ConvertTo-Json -Depth 6
