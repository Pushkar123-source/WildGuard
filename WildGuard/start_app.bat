@echo off
setlocal
cd /d "%~dp0"

set "VENV_DIR=.venv"
if exist ".codex-run-venv\Scripts\python.exe" (
  set "VENV_DIR=.codex-run-venv"
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo Creating local Python environment...
  py -m venv "%VENV_DIR%"
  if errorlevel 1 (
    python -m venv "%VENV_DIR%"
  )
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo Could not find Python. Please install Python, then run this file again.
  pause
  exit /b 1
)

echo Updating installer...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip

echo Installing required packages...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Package installation failed.
  pause
  exit /b 1
)

echo Opening Wildlife Protection Command...
start "" "http://127.0.0.1:8000"
"%VENV_DIR%\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 8000

pause
