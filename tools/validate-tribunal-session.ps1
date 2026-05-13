Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$configPath = Join-Path $env:USERPROFILE ".codex\process-automation\tribunal-session.env"

function Import-SessionConfig {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) { continue }
        $separator = $trimmed.IndexOf("=")
        if ($separator -le 0) { continue }
        $name = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($name -match "^[A-Z_][A-Z0-9_]*$") {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
    return $true
}

function Test-BrowserWs {
    param([string]$WsUrl)
    if ([string]::IsNullOrWhiteSpace($WsUrl)) { return $null }
    $httpUrl = $WsUrl -replace "^ws://", "http://" -replace "^wss://", "https://"
    $httpUrl = $httpUrl -replace "/devtools/browser/.*$", "/json/version"
    try {
        $info = Invoke-RestMethod -Uri $httpUrl -Method Get -TimeoutSec 10
        return [pscustomobject]@{ ok = $true; endpoint = $httpUrl; browser = $info.Browser }
    } catch {
        return [pscustomobject]@{ ok = $false; endpoint = $httpUrl; error = $_.Exception.Message }
    }
}

$loaded = Import-SessionConfig -Path $configPath

$profileExists = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_PROFILE_DIR) -and (Test-Path -LiteralPath $env:TRIBUNAL_PROFILE_DIR -PathType Container)
$wsCheck = Test-BrowserWs -WsUrl $env:TRIBUNAL_BROWSER_WS
$sessionReady = (-not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_BROWSER_WS)) -or ($profileExists -and $env:TRIBUNAL_SESSION_CONFIRMED -eq "1")

[pscustomobject]@{
    ok = $sessionReady
    configPath = $configPath
    loadedSessionConfig = $loaded
    hasTribunalBrowserWs = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_BROWSER_WS)
    browserWsCheck = $wsCheck
    hasTribunalProfileDir = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_PROFILE_DIR)
    tribunalChromeProfileDirectory = $env:TRIBUNAL_CHROME_PROFILE_DIRECTORY
    tribunalProfileDirExists = $profileExists
    tribunalSessionConfirmed = $env:TRIBUNAL_SESSION_CONFIRMED -eq "1"
    message = if ($sessionReady) { "Sessao de tribunal pronta para o preflight." } elseif (-not $loaded) { "Arquivo local de sessao ainda nao existe. Rode tools\\prepare-tribunal-session.ps1 para preparar." } else { "Sessao de tribunal ainda nao esta pronta para automacao." }
} | ConvertTo-Json -Depth 5
