Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$processesUrl = "https://dashboard-vg-default-rtdb.firebaseio.com/dashboard/processes.json"
$cnjPattern = "\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b"
$sessionConfigPath = Join-Path $env:USERPROFILE ".codex\process-automation\tribunal-session.env"

function Import-SessionConfig {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }

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

$loadedSessionConfig = Import-SessionConfig -Path $sessionConfigPath

function ConvertFrom-JsonStrict {
    param([string]$Text, [string]$Method)
    if ([string]::IsNullOrWhiteSpace($Text)) {
        throw "$Method retornou resposta vazia."
    }
    return $Text | ConvertFrom-Json
}

function Invoke-FirebaseRead {
    param([string]$Url)

    $errors = @()

    try {
        return [pscustomobject]@{
            method = "Invoke-RestMethod"
            data = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 45 -Headers @{ "Cache-Control" = "no-cache" }
            errors = $errors
        }
    } catch {
        $errors += "Invoke-RestMethod: $($_.Exception.Message)"
    }

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 45 -UseBasicParsing -Headers @{ "Cache-Control" = "no-cache" }
        return [pscustomobject]@{
            method = "Invoke-WebRequest"
            data = ConvertFrom-JsonStrict -Text ([string]$response.Content) -Method "Invoke-WebRequest"
            errors = $errors
        }
    } catch {
        $errors += "Invoke-WebRequest: $($_.Exception.Message)"
    }

    $curlPath = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curlPath) {
        try {
            $curlOutput = & $curlPath.Source --silent --show-error --fail --location --connect-timeout 15 --max-time 45 --tlsv1.2 --ssl-no-revoke --header "Cache-Control: no-cache" $Url 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe saiu com codigo $LASTEXITCODE`: $($curlOutput -join [Environment]::NewLine)"
            }
            return [pscustomobject]@{
                method = "curl.exe"
                data = ConvertFrom-JsonStrict -Text (($curlOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) -Method "curl.exe"
                errors = $errors
            }
        } catch {
            $errors += "curl.exe: $($_.Exception.Message)"
        }
    } else {
        $errors += "curl.exe: nao encontrado no PATH."
    }

    $nodeCommand = $null
    foreach ($candidate in @("node.exe", "node")) {
        $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($resolved) {
            if ($resolved.Source -and (Test-Path -LiteralPath $resolved.Source)) {
                $nodeCommand = $resolved.Source
            } else {
                $nodeCommand = $candidate
            }
            break
        }
    }
    if ($nodeCommand) {
        $nodeScript = $null
        try {
            $nodeScript = Join-Path $PSScriptRoot ("firebase-read-" + [guid]::NewGuid().ToString("N") + ".js")
            $script = @'
const https = require('https');
const url = process.argv[2];
const req = https.get(url, { headers: { 'Cache-Control': 'no-cache' }, timeout: 45000 }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`);
      process.exit(2);
    }
    process.stdout.write(body);
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
'@
            Set-Content -LiteralPath $nodeScript -Value $script -Encoding UTF8
            $nodeOutput = & $nodeCommand $nodeScript $Url 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "node saiu com codigo $LASTEXITCODE`: $($nodeOutput -join [Environment]::NewLine)"
            }
            return [pscustomobject]@{
                method = "node https"
                data = ConvertFrom-JsonStrict -Text (($nodeOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) -Method "node https"
                errors = $errors
            }
        } catch {
            $errors += "node https: $($_.Exception.Message)"
        } finally {
            if ($nodeScript -and (Test-Path -LiteralPath $nodeScript)) {
                Remove-Item -LiteralPath $nodeScript -Force -ErrorAction SilentlyContinue
            }
        }
    } else {
        $errors += "node https: node nao encontrado no PATH."
    }

    $client = $null
    try {
        Add-Type -AssemblyName System.Net.Http
        $handler = New-Object System.Net.Http.HttpClientHandler
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(45)
        $client.DefaultRequestHeaders.CacheControl = New-Object System.Net.Http.Headers.CacheControlHeaderValue
        $client.DefaultRequestHeaders.CacheControl.NoCache = $true
        $text = $client.GetStringAsync($Url).GetAwaiter().GetResult()
        return [pscustomobject]@{
            method = ".NET HttpClient"
            data = ConvertFrom-JsonStrict -Text $text -Method ".NET HttpClient"
            errors = $errors
        }
    } catch {
        $errors += ".NET HttpClient: $($_.Exception.Message)"
    } finally {
        if ($client) { $client.Dispose() }
    }

    throw ($errors -join " | ")
}

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
    loadedSessionConfig = $loadedSessionConfig
    hasTribunalBrowserWs = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_BROWSER_WS)
    hasTribunalProfileDir = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_PROFILE_DIR)
    tribunalProfileDirExists = -not [string]::IsNullOrWhiteSpace($env:TRIBUNAL_PROFILE_DIR) -and (Test-Path -LiteralPath $env:TRIBUNAL_PROFILE_DIR -PathType Container)
    tribunalSessionConfirmed = $env:TRIBUNAL_SESSION_CONFIRMED -eq "1"
    hasGmailConnectorHint = -not [string]::IsNullOrWhiteSpace($env:GMAIL_CONNECTOR_AVAILABLE)
}
$hasTribunalSession = $environment.hasTribunalBrowserWs -or ($environment.tribunalProfileDirExists -and $environment.tribunalSessionConfirmed)

try {
    $firebaseRead = Invoke-FirebaseRead -Url $processesUrl
    $raw = $firebaseRead.data
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
            if (-not $hasTribunalSession) {
                "Ambiente automatico sem TRIBUNAL_BROWSER_WS ou TRIBUNAL_PROFILE_DIR; nao ha sessao autenticada de tribunal para leitura de teor."
            }
            if ($environment.hasTribunalProfileDir -and -not $environment.tribunalProfileDirExists) {
                "TRIBUNAL_PROFILE_DIR foi informado, mas o diretorio nao existe no ambiente automatico."
            }
            if ($environment.tribunalProfileDirExists -and -not $environment.tribunalSessionConfirmed -and -not $environment.hasTribunalBrowserWs) {
                "TRIBUNAL_PROFILE_DIR existe, mas TRIBUNAL_SESSION_CONFIRMED=1 nao foi configurado apos login/autenticacao dos tribunais."
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
    readMethod = $firebaseRead.method
    readFallbackErrors = @($firebaseRead.errors)
    totalProcesses = $processes.Count
    eligibleCnjs = $eligible.Count
    maxVerificationPtBr = if ($null -ne $maxVerification) { $maxVerification.ToString("dd/MM/yyyy") } else { $null }
    maxVerificationIso = if ($null -ne $maxVerification) { $maxVerification.ToString("yyyy-MM-dd") } else { $null }
    todayPtBr = (Get-Date).ToString("dd/MM/yyyy")
    environment = $environment
    blockers = @(
        if (-not $hasTribunalSession) {
            "Ambiente automatico sem TRIBUNAL_BROWSER_WS ou TRIBUNAL_PROFILE_DIR; nao ha sessao autenticada de tribunal para leitura de teor."
        }
        if ($environment.hasTribunalProfileDir -and -not $environment.tribunalProfileDirExists) {
            "TRIBUNAL_PROFILE_DIR foi informado, mas o diretorio nao existe no ambiente automatico."
        }
        if ($environment.tribunalProfileDirExists -and -not $environment.tribunalSessionConfirmed -and -not $environment.hasTribunalBrowserWs) {
            "TRIBUNAL_PROFILE_DIR existe, mas TRIBUNAL_SESSION_CONFIRMED=1 nao foi configurado apos login/autenticacao dos tribunais."
        }
        if (-not $environment.hasGmailConnectorHint) {
            "Ambiente automatico sem indicio de conector Gmail disponivel; pushes podem ficar indisponiveis."
        }
    )
    sample = @($eligible | Select-Object -First 10)
}

$result | ConvertTo-Json -Depth 6
