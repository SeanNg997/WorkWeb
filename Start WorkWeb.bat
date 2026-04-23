@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 后再双击启动。
  echo 下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launch.js"
if errorlevel 1 (
  echo.
  echo 启动失败，请查看 runtime\workweb-server.log
  echo.
  pause
  exit /b 1
)

endlocal
