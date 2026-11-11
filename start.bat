@echo off
title Gallium Backend
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning src/index.js %*
if errorlevel 1 pause
