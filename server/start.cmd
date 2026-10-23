@echo off
rem Windows: load .env into this window and start the Ferry server (not affected by script execution policy)
cd /d "%~dp0"
if not exist .env (
  echo .env not found: copy .env.example to .env and fill it in
  exit /b 1
)
rem Empty values are skipped, so a key already set in Windows environment variables is kept
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not "%%b"=="" set "%%a=%%b"
set "PY=python"
if exist "%~dp0..\.venv\Scripts\python.exe" set "PY=%~dp0..\.venv\Scripts\python.exe"
"%PY%" -m ferry_server --config ferry-server.toml %*
