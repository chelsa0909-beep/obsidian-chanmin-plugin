<# : batch script
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ((Get-Content '%~f0' -Raw) -replace '(?s)\<#.*?#\>', '')"
goto :EOF
#>
Write-Host "Hello from Powershell"
