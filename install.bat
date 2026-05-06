@echo off
chcp 65001 > nul
setlocal

cd /d "%~dp0"
set "PS_SCRIPT=%~dp0install.ps1"

if not exist "%PS_SCRIPT%" (
    echo [오류] 같은 폴더에서 install.ps1 파일을 찾을 수 없습니다.
    pause
    exit /b
)

echo 옵시디언 플러그인 자동 설치를 시작합니다...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
