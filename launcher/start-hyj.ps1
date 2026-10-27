$ErrorActionPreference = 'Stop'

# ============================================================
# HYJ local one-click launcher
# ============================================================

$GatewayDir = 'D:\CODE\huayuejiang-miniapp-gateway'
$MiniappDir = 'D:\CODE\huayuejiang-miniapp-test'
$MiniappConfig = Join-Path $MiniappDir 'utils\config.js'


$LauncherDir = 'D:\CODE\huayuejiang-launcher'
$CloudflaredDir =
    Join-Path $LauncherDir 'bin'

$CloudflaredExe =
    Join-Path $CloudflaredDir 'cloudflared.exe'

$GatewayOutLog = Join-Path $LauncherDir 'gateway.out.log'
$GatewayErrLog = Join-Path $LauncherDir 'gateway.err.log'

$TunnelOutLog = Join-Path $LauncherDir 'cloudflared.out.log'
$TunnelErrLog = Join-Path $LauncherDir 'cloudflared.err.log'

$GatewayPidFile = Join-Path $LauncherDir 'gateway.pid'
$TunnelPidFile = Join-Path $LauncherDir 'cloudflared.pid'
$WeChatCliCache = Join-Path $LauncherDir 'wechat-cli.txt'

$RagflowContainer = 'docker-ragflow-cpu-1'

$DependencyContainers = @(
    'docker-mysql-1',
    'docker-es01-1',
    'docker-minio-1',
    'docker-redis-1'
)


function Step {
    param(
        [string]$Text
    )

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor DarkGray
    Write-Host $Text -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor DarkGray
}


function Ok {
    param(
        [string]$Text
    )

    Write-Host ('[OK] ' + $Text) -ForegroundColor Green
}


function Warn {
    param(
        [string]$Text
    )

    Write-Host ('[WARN] ' + $Text) -ForegroundColor Yellow
}


function Test-HttpHealth {
    param(
        [string]$Url,
        [int]$TimeoutSec = 5
    )

    try {
        $r = Invoke-RestMethod `
            -Uri $Url `
            -Method Get `
            -TimeoutSec $TimeoutSec

        if ($null -ne $r) {
            return $true
        }
    }
    catch {
    }

    return $false
}


function Wait-HttpHealth {
    param(
        [string]$Url,
        [string]$Name,
        [int]$MaxSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($MaxSeconds)

    while ((Get-Date) -lt $deadline) {
        if (Test-HttpHealth -Url $Url -TimeoutSec 4) {
            Ok ($Name + ' is ready')
            return
        }

        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }

    Write-Host ''
    throw ($Name + ' startup timeout: ' + $Url)
}


function Test-DockerReady {
    try {
        & docker info *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}


function Ensure-Docker {
    Step '1/7 Docker Desktop'

    if (Test-DockerReady) {
        Ok 'Docker Engine is already running'
        return
    }

    $dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

    if (-not (Test-Path $dockerExe)) {
        throw ('Docker Desktop not found: ' + $dockerExe)
    }

    Write-Host 'Starting Docker Desktop...'

    Start-Process `
        -FilePath $dockerExe | Out-Null

    $deadline = (Get-Date).AddMinutes(3)

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3

        if (Test-DockerReady) {
            Ok 'Docker Engine started'
            return
        }
    }

    throw 'Docker Desktop startup timeout'
}


function Container-Exists {
    param(
        [string]$Name
    )

    $all = @(
        & docker ps -a --format '{{.Names}}'
    )

    return ($all -contains $Name)
}


function Container-Running {
    param(
        [string]$Name
    )

    try {
        $state = & docker inspect `
            -f '{{.State.Running}}' `
            $Name `
            2>$null

        return ($state.Trim() -eq 'true')
    }
    catch {
        return $false
    }
}


function Ensure-Ragflow {
    Step '2/7 RAGFlow containers'

    foreach ($name in $DependencyContainers) {
        if (-not (Container-Exists -Name $name)) {
            throw ('Docker container not found: ' + $name)
        }

        if (Container-Running -Name $name) {
            Ok ($name + ' already running')
        }
        else {
            Write-Host ('Starting ' + $name + ' ...')
            & docker start $name | Out-Null
        }
    }

    Start-Sleep -Seconds 3

    if (-not (Container-Exists -Name $RagflowContainer)) {
        throw ('Docker container not found: ' + $RagflowContainer)
    }

    if (Container-Running -Name $RagflowContainer) {
        Ok ($RagflowContainer + ' already running')
    }
    else {
        Write-Host ('Starting ' + $RagflowContainer + ' ...')
        & docker start $RagflowContainer | Out-Null
    }

    Wait-HttpHealth `
        -Url 'http://127.0.0.1/api/v1/system/healthz' `
        -Name 'RAGFlow' `
        -MaxSeconds 180
}


function Ensure-Gateway {
    Step '3/7 Gateway'

    if (Test-HttpHealth -Url 'http://127.0.0.1:8787/health') {
        Ok 'Gateway is already running'
        return
    }

    $serverJs = Join-Path $GatewayDir 'server.js'
    $envFile = Join-Path $GatewayDir '.env'

    if (-not (Test-Path $serverJs)) {
        throw ('server.js not found: ' + $serverJs)
    }

    if (-not (Test-Path $envFile)) {
        throw ('.env not found: ' + $envFile)
    }

    $nodeExe = (Get-Command node).Source

    Remove-Item $GatewayOutLog -Force -ErrorAction SilentlyContinue
    Remove-Item $GatewayErrLog -Force -ErrorAction SilentlyContinue

    $p = Start-Process `
        -FilePath $nodeExe `
        -ArgumentList @(
            '--env-file=.env',
            'server.js'
        ) `
        -WorkingDirectory $GatewayDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $GatewayOutLog `
        -RedirectStandardError $GatewayErrLog `
        -PassThru

    Set-Content `
        -Path $GatewayPidFile `
        -Value $p.Id `
        -Encoding ASCII

    Write-Host ('Gateway PID: ' + $p.Id)

    Wait-HttpHealth `
        -Url 'http://127.0.0.1:8787/health' `
        -Name 'Gateway' `
        -MaxSeconds 30
}


function Get-ConfiguredTunnelUrl {
    if (-not (Test-Path $MiniappConfig)) {
        return $null
    }

    $text = [System.IO.File]::ReadAllText($MiniappConfig)

    $m = [regex]::Match(
        $text,
        'https://[a-zA-Z0-9-]+\.trycloudflare\.com'
    )

    if ($m.Success) {
        return $m.Value
    }

    return $null
}


function Get-TunnelUrlFromLogs {
    $text = ''

    if (Test-Path $TunnelOutLog) {
        $text += [System.IO.File]::ReadAllText($TunnelOutLog)
    }

    if (Test-Path $TunnelErrLog) {
        $text += "`n"
        $text += [System.IO.File]::ReadAllText($TunnelErrLog)
    }

    $m = [regex]::Match(
        $text,
        'https://[a-zA-Z0-9-]+\.trycloudflare\.com'
    )

    if ($m.Success) {
        return $m.Value
    }

    return $null
}


function Stop-LauncherTunnel {
    if (-not (Test-Path $TunnelPidFile)) {
        return
    }

    try {
        $oldPidText = (
            Get-Content $TunnelPidFile -Raw
        ).Trim()

        if ($oldPidText) {
            $oldPid = [int]$oldPidText

            $proc = Get-Process `
                -Id $oldPid `
                -ErrorAction SilentlyContinue

            if ($proc) {
                Write-Host ('Stopping old launcher tunnel PID ' + $oldPid)

                Stop-Process `
                    -Id $oldPid `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
    }

    Remove-Item `
        $TunnelPidFile `
        -Force `
        -ErrorAction SilentlyContinue
}


function Update-MiniappConfig {
    param(
        [string]$Url
    )

    if (-not (Test-Path $MiniappConfig)) {
        throw ('Miniapp config not found: ' + $MiniappConfig)
    }

    $content = [System.IO.File]::ReadAllText($MiniappConfig)

    $pattern = 'GATEWAY_BASE_URL\s*:\s*[''"][^''"]+[''"]'

    if (-not [regex]::IsMatch($content, $pattern)) {
        throw 'GATEWAY_BASE_URL not found in utils\config.js'
    }

    $replacement = "GATEWAY_BASE_URL: '" + $Url + "'"

    $newContent = [regex]::Replace(
        $content,
        $pattern,
        $replacement,
        1
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    [System.IO.File]::WriteAllText(
        $MiniappConfig,
        $newContent,
        $utf8NoBom
    )

    Ok ('Miniapp config updated: ' + $Url)
}


function Ensure-Tunnel {
    Step '4/7 Cloudflare Tunnel'

    $currentUrl = Get-ConfiguredTunnelUrl

    if ($currentUrl) {
        Write-Host ('Checking current tunnel: ' + $currentUrl)

        if (
            Test-HttpHealth `
                -Url ($currentUrl + '/health') `
                -TimeoutSec 8
        ) {
            Ok 'Current tunnel is still alive'
            return $currentUrl
        }
    }

    if (-not (Test-Path $CloudflaredExe)) {
        throw ('cloudflared not found: ' + $CloudflaredExe)
    }

    Write-Host 'Current tunnel is unavailable.'
    Write-Host 'Creating a new Quick Tunnel...'

    Stop-LauncherTunnel

    Remove-Item $TunnelOutLog -Force -ErrorAction SilentlyContinue
    Remove-Item $TunnelErrLog -Force -ErrorAction SilentlyContinue

    $p = Start-Process `
        -FilePath $CloudflaredExe `
        -ArgumentList @(
            'tunnel',
            '--url',
            'http://127.0.0.1:8787'
        ) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $TunnelOutLog `
        -RedirectStandardError $TunnelErrLog `
        -PassThru

    Set-Content `
        -Path $TunnelPidFile `
        -Value $p.Id `
        -Encoding ASCII

    Write-Host ('cloudflared PID: ' + $p.Id)

    $deadline = (Get-Date).AddSeconds(75)
    $url = $null

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1

        $url = Get-TunnelUrlFromLogs

        if ($url) {
            break
        }

        Write-Host '.' -NoNewline
    }

    Write-Host ''

    if (-not $url) {
        throw (
            'Could not obtain trycloudflare URL. Check log: ' +
            $TunnelErrLog
        )
    }

    Write-Host ('Tunnel URL: ' + $url) -ForegroundColor Green

    Wait-HttpHealth `
        -Url ($url + '/health') `
        -Name 'Public HTTPS tunnel' `
        -MaxSeconds 90

    Update-MiniappConfig -Url $url

    return $url
}


function Find-WeChatCli {
    if (Test-Path $WeChatCliCache) {
        try {
            $cached = (
                Get-Content $WeChatCliCache -Raw
            ).Trim()

            if ($cached -and (Test-Path $cached)) {
                return $cached
            }
        }
        catch {
        }
    }

    if ($env:WECHAT_DEVTOOLS_CLI) {
        if (Test-Path $env:WECHAT_DEVTOOLS_CLI) {
            return $env:WECHAT_DEVTOOLS_CLI
        }
    }

    $roots = @()

    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path $env:LOCALAPPDATA 'Programs')
    }

    if ($env:ProgramFiles) {
        $roots += $env:ProgramFiles
    }

    if (${env:ProgramFiles(x86)}) {
        $roots += ${env:ProgramFiles(x86)}
    }

    foreach ($root in $roots) {
        if (-not (Test-Path $root)) {
            continue
        }

        try {
            $items = Get-ChildItem `
                -Path $root `
                -Filter 'cli.bat' `
                -File `
                -Recurse `
                -ErrorAction SilentlyContinue

            foreach ($item in $items) {
                if (
                    $item.FullName -match 'Tencent' -or
                    $item.FullName -match 'WeChat' -or
                    $item.FullName -match 'wechat' -or
                    $item.FullName -match 'weixin'
                ) {
                    Set-Content `
                        -Path $WeChatCliCache `
                        -Value $item.FullName `
                        -Encoding UTF8

                    return $item.FullName
                }
            }
        }
        catch {
        }
    }

    return $null
}


function Open-WeChatProject {
    Step '5/7 WeChat DevTools'

    $cli = Find-WeChatCli

    if (-not $cli) {
        Warn 'WeChat DevTools CLI was not found automatically'
        Warn 'Backend services are ready; open WeChat DevTools manually this time'
        return
    }

    Write-Host ('WeChat CLI: ' + $cli)

    try {
        & $cli open --project $MiniappDir | Out-Null
        Ok 'WeChat miniapp project open command sent'
    }
    catch {
        Warn ('Could not open project automatically: ' + $_.Exception.Message)
    }
}


function Final-Check {
    param(
        [string]$TunnelUrl
    )

    Step '6/7 Final health check'

    Wait-HttpHealth `
        -Url 'http://127.0.0.1/api/v1/system/healthz' `
        -Name 'RAGFlow' `
        -MaxSeconds 20

    Wait-HttpHealth `
        -Url 'http://127.0.0.1:8787/health' `
        -Name 'Gateway' `
        -MaxSeconds 20

    Wait-HttpHealth `
        -Url ($TunnelUrl + '/health') `
        -Name 'Public HTTPS' `
        -MaxSeconds 30
}


try {
    Clear-Host

    Write-Host ''
    Write-Host 'HYJ AI Customer Service - One Click Start' -ForegroundColor Green
    Write-Host ''

    Ensure-Docker

    Ensure-Ragflow

    Ensure-Gateway

    $TunnelUrl = Ensure-Tunnel

    Open-WeChatProject

    Final-Check -TunnelUrl $TunnelUrl

    Step '7/7 READY'

    Write-Host ''
    Write-Host 'RAGFlow       : OK' -ForegroundColor Green
    Write-Host 'Gateway       : OK' -ForegroundColor Green
    Write-Host ('Public URL    : ' + $TunnelUrl) -ForegroundColor Green
    Write-Host 'Miniapp config: OK' -ForegroundColor Green
    Write-Host ''

    Write-Host ('Gateway log   : ' + $GatewayOutLog)
    Write-Host ('Gateway errors: ' + $GatewayErrLog)
    Write-Host ('Tunnel log    : ' + $TunnelErrLog)

    Write-Host ''
    Write-Host 'Launcher finished. Background services stay running.' -ForegroundColor Cyan

    Start-Sleep -Seconds 5
}
catch {
    Write-Host ''
    Write-Host 'STARTUP FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''

    Write-Host 'Do not edit the script yet.' -ForegroundColor Yellow
    Write-Host 'Send me this error screen.' -ForegroundColor Yellow
    Write-Host ''

    Read-Host 'Press Enter to exit'
    exit 1
}