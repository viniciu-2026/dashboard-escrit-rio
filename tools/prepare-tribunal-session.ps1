param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".codex\process-automation\tribunal-profile"),
    [int]$RemoteDebuggingPort = 9227,
    [switch]$ConfirmAfterLogin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$configDir = Join-Path $env:USERPROFILE ".codex\process-automation"
$configPath = Join-Path $configDir "tribunal-session.env"

function Find-Browser {
    $candidates = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    throw "Chrome/Edge nao encontrado para preparar perfil persistente."
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$confirmed = if ($ConfirmAfterLogin) { "1" } else { "0" }
@(
    "# Arquivo local nao versionado. Nao colocar senhas aqui.",
    "TRIBUNAL_PROFILE_DIR=$ProfileDir",
    "TRIBUNAL_SESSION_CONFIRMED=$confirmed",
    "# Opcional: TRIBUNAL_BROWSER_WS=ws://host:port/devtools/browser/id"
) | Set-Content -LiteralPath $configPath -Encoding UTF8

$browser = Find-Browser
$urls = @(
    "https://portaldeservicos.pdpj.jus.br/consulta",
    "https://www.tjrj.jus.br/sistemas-judiciais",
    "https://tjrj.pje.jus.br/1g/loginOld.seam"
)

$arguments = @(
    "--user-data-dir=$ProfileDir",
    "--remote-debugging-port=$RemoteDebuggingPort",
    "--no-first-run",
    "--no-default-browser-check"
) + $urls

Start-Process -FilePath $browser -ArgumentList $arguments

[pscustomobject]@{
    ok = $true
    configPath = $configPath
    profileDir = $ProfileDir
    remoteDebuggingPort = $RemoteDebuggingPort
    sessionConfirmed = $confirmed
    nextStep = "Faca login nos tribunais/GOV no navegador aberto. Depois rode este script com -ConfirmAfterLogin para marcar TRIBUNAL_SESSION_CONFIRMED=1."
} | ConvertTo-Json -Depth 4
