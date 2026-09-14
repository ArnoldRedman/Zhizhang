[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$releaseRoot = Join-Path $projectRoot 'desktop-app\src-tauri\target\release'
$logRoot = Join-Path $projectRoot 'local-releases'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logRoot "build-windows-$stamp.log"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
    Write-Host "> $FilePath $($ArgumentList -join ' ')" -ForegroundColor DarkGray
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败（退出码 $LASTEXITCODE）：$FilePath $($ArgumentList -join ' ')"
    }
}

function Resolve-Tool([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "未找到 $Name，请安装对应工具并将其加入 PATH"
    }
    return $command.Source
}

function Stop-WorkspaceProcesses {
    if (-not (Test-Path -LiteralPath $releaseRoot)) {
        return
    }

    $fullReleaseRoot = ([IO.Path]::GetFullPath($releaseRoot)).TrimEnd('\') + '\'
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $executablePath = $_.ExecutablePath
        $commandLine = $_.CommandLine
        $pathMatches = $false
        $commandMatches = $false
        if ($executablePath) {
            try {
                $pathMatches = ([IO.Path]::GetFullPath($executablePath)).StartsWith($fullReleaseRoot, [StringComparison]::OrdinalIgnoreCase)
            } catch {
                $pathMatches = $false
            }
        }
        if ($commandLine) {
            $commandMatches = $commandLine.IndexOf($fullReleaseRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        $pathMatches -or $commandMatches
    })

    foreach ($process in $processes) {
        Write-Host "关闭旧进程：$($process.Name) [PID $($process.ProcessId)]" -ForegroundColor Yellow
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($processes.Count -gt 0) {
        Start-Sleep -Milliseconds 700
    }
}

function Get-AppVersion {
    $configPath = Join-Path $projectRoot 'desktop-app\src-tauri\tauri.conf.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.version) {
        throw "tauri.conf.json 中没有找到版本号"
    }
    return [string]$config.version
}

$transcriptStarted = $false
try {
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    $transcriptStarted = $true
    Write-Host "项目目录：$projectRoot"
    Write-Host "日志文件：$logPath"
    Write-Host "开始时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

    Write-Step '检查构建工具'
    $nodeCommand = Resolve-Tool 'node'
    $npmCommand = Resolve-Tool 'npm'
    $cargoCommand = Resolve-Tool 'cargo'
    $gitCommand = Resolve-Tool 'git'
    Write-Host "Node：$(& $nodeCommand --version)"
    Write-Host "npm：$(& $npmCommand --version)"
    Write-Host "Cargo：$(& $cargoCommand --version)"
    Write-Host "Git：$(& $gitCommand --version)"

    Stop-WorkspaceProcesses

    Write-Step '安装工作区依赖'
    Invoke-Checked $npmCommand @('install')
    Invoke-Checked $npmCommand @('install', '--prefix', 'desktop-app')

    if ($SkipTests) {
        Write-Host '已跳过测试（-SkipTests）' -ForegroundColor Yellow
    } else {
        Write-Step '运行 Agent Runtime 类型检查'
        Invoke-Checked $npmCommand @('--workspace', '@zhizhang/agent-runtime', 'run', 'typecheck')

        # 前端检查放在 Rust 测试和 tauri build 之前：类型错误几秒就能报出来，不用等十几分钟的编译跑完才知道
        Write-Step '运行前端类型检查、lint 与测试'
        Invoke-Checked $npmCommand @('run', 'check:desktop')

        Write-Step '运行项目 Agent 回归测试'
        Invoke-Checked $npmCommand @('--workspace', '@zhizhang/agent-runtime', 'test', '--', '--run', 'tests/project-agent.test.ts')

        Write-Step '运行 Rust 测试'
        Invoke-Checked $cargoCommand @('test', '--manifest-path', 'desktop-app/src-tauri/Cargo.toml')
    }

    Write-Step '构建 Windows 安装包'
    Invoke-Checked $npmCommand @('run', 'tauri:build', '--prefix', 'desktop-app')

    $version = Get-AppVersion
    $outputs = @(
        (Join-Path $releaseRoot "bundle\nsis\Zhizhang_${version}_x64-setup.exe"),
        (Join-Path $releaseRoot "bundle\msi\Zhizhang_${version}_x64_en-US.msi")
    )

    Write-Step '核对构建产物'
    foreach ($output in $outputs) {
        if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
            throw "没有找到预期构建产物：$output"
        }
        $item = Get-Item -LiteralPath $output
        $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
        Write-Host $item.FullName -ForegroundColor Green
        Write-Host "  大小：$([math]::Round($item.Length / 1MB, 2)) MB"
        Write-Host "  SHA256：$hash"
    }

    Write-Host "`n构建完成：织章 v$version" -ForegroundColor Green
    Write-Host "安装包目录：$(Join-Path $releaseRoot 'bundle')" -ForegroundColor Green
    exit 0
} catch {
    Write-Host "`n构建失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "完整日志：$logPath" -ForegroundColor Yellow
    exit 1
} finally {
    if ($transcriptStarted) {
        try {
            Stop-Transcript | Out-Null
        } catch {
        }
    }
}
