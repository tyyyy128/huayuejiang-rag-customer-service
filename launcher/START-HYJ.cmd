@echo off
title HYJ AI Customer Service Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\CODE\huayuejiang-launcher\start-hyj.ps1"

if errorlevel 1 (
    echo.
    echo Startup failed.
    pause
)