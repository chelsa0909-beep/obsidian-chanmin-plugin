[console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repo = "chelsa0909-beep/obsidian-chanmin-plugin"
$pluginId = "obsidian-chanmin-plugin"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Obsidian Chanmin Plugin 자동 설치 프로그램" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "GitHub에서 최신 릴리스 정보를 가져오는 중..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"

try {
    $response = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
} catch {
    Write-Host "릴리스 정보를 가져오는데 실패했습니다. 인터넷 연결이나 GitHub API 상태를 확인해주세요." -ForegroundColor Red
    Pause
    exit
}

$assets = $response.assets
if ($assets.Count -eq 0) {
    Write-Host "최신 릴리스에 다운로드할 파일이 없습니다." -ForegroundColor Red
    Pause
    exit
}

Write-Host "최신 버전: $($response.tag_name)" -ForegroundColor Green

# 옵시디언 볼트 찾기
$obsidianJsonPath = Join-Path $env:APPDATA "obsidian\obsidian.json"
if (-not (Test-Path $obsidianJsonPath)) {
    Write-Host "옵시디언 설정 파일을 찾을 수 없습니다: $obsidianJsonPath" -ForegroundColor Red
    Write-Host "옵시디언이 설치되어 있고 최소 하나의 볼트(Vault)가 생성되어 있는지 확인해주세요." -ForegroundColor Red
    Pause
    exit
}

$obsidianConfig = Get-Content $obsidianJsonPath -Raw | ConvertFrom-Json
$vaults = $obsidianConfig.vaults.PSObject.Properties

if ($vaults.Count -eq 0) {
    Write-Host "옵시디언 볼트를 찾을 수 없습니다." -ForegroundColor Red
    Pause
    exit
}

$selectedVaultPath = $null
if ($vaults.Count -eq 1) {
    $selectedVaultPath = $vaults.Value.path
    Write-Host "발견된 볼트 경로: $selectedVaultPath"
} else {
    Write-Host "여러 개의 옵시디언 볼트가 발견되었습니다:"
    $i = 1
    $vaultList = @()
    foreach ($vault in $vaults) {
        Write-Host "$i. $($vault.Value.path)"
        $vaultList += $vault.Value.path
        $i++
    }
    
    Write-Host ""
    $selection = Read-Host "플러그인을 설치할 볼트를 선택하세요 (1-$($vaultList.Count))"
    $selectedIndex = [int]$selection - 1
    if ($selectedIndex -ge 0 -and $selectedIndex -lt $vaultList.Count) {
        $selectedVaultPath = $vaultList[$selectedIndex]
    } else {
        Write-Host "잘못된 선택입니다." -ForegroundColor Red
        Pause
        exit
    }
}

if (-not (Test-Path $selectedVaultPath)) {
    Write-Host "선택한 볼트 경로가 존재하지 않습니다: $selectedVaultPath" -ForegroundColor Red
    Pause
    exit
}

$pluginDir = Join-Path $selectedVaultPath ".obsidian\plugins\$pluginId"
if (-not (Test-Path $pluginDir)) {
    Write-Host "플러그인 폴더를 생성합니다: $pluginDir"
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
}

Write-Host ""
Write-Host "파일 다운로드 중 ($pluginDir)..."
foreach ($asset in $assets) {
    $downloadUrl = $asset.browser_download_url
    $fileName = $asset.name
    $destination = Join-Path $pluginDir $fileName
    Write-Host "$fileName 다운로드 중..."
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $destination -UseBasicParsing
    } catch {
        Write-Host "$fileName 다운로드에 실패했습니다." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "설치가 완료되었습니다!" -ForegroundColor Green
Write-Host "옵시디언을 재시작한 후 [설정] -> [커뮤니티 플러그인]에서 플러그인을 활성화해주세요." -ForegroundColor Yellow
Write-Host "=================================================" -ForegroundColor Cyan
Pause
