@echo off
setlocal

:: ── Locate a suitable Python interpreter ──────────────────────────
:: Priority: .venv312 > py -3.12 > py -3.11 > py -3 > python
set "PY="

if exist ".venv312\Scripts\python.exe" (
  set "PY=.venv312\Scripts\python.exe"
  goto :found
)

where py >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%p in ('py -3.12 -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%p"
  if defined PY goto :found
  for /f "delims=" %%p in ('py -3.11 -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%p"
  if defined PY goto :found
)

py -3 -c "import sys; v=sys.version_info; exit(0 if v.minor in range(8,14) else 1)" >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%p in ('py -3 -c "import sys; print(sys.executable)"') do set "PY=%%p"
  if defined PY goto :found
)

python -c "import sys; v=sys.version_info; exit(0 if v.major==3 and v.minor in range(8,14) else 1)" >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%p in ('python -c "import sys; print(sys.executable)"') do set "PY=%%p"
  if defined PY goto :found
)

echo.
echo [ERROR] No compatible Python (3.8-3.13) found.
echo Install Python 3.12 from https://www.python.org/downloads/
echo Or create a local venv:  py -3.12 -m venv .venv312
echo.
pause
exit /b 1

:found
echo Using: %PY%
"%PY%" -c "import sys;v=sys.version_info;print(str(v.major)+'.'+str(v.minor)+'.'+str(v.micro))" > "%TEMP%\_peak_pyver.txt" 2>nul
set /p PYVER=<"%TEMP%\_peak_pyver.txt"
del "%TEMP%\_peak_pyver.txt" 2>nul
echo Python %PYVER%
echo.

:: ── Install dependencies ──────────────────────────────────────────
echo Installing dependencies...
"%PY%" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 goto :fail

"%PY%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo [ERROR] Dependency install failed on Python %PYVER%.
  echo Tip: create a clean venv and retry:
  echo   "%PY%" -m venv .venv312
  echo   .venv312\Scripts\python.exe -m pip install -r requirements.txt
  echo.
  goto :fail
)

:: ── Build exe ─────────────────────────────────────────────────────
echo.
echo Building .exe...
"%PY%" -m PyInstaller --onefile --windowed --name "Peak" --icon "peak.ico" --add-data "index.html;." --add-data "style.css;." --add-data "app.js;." --add-data "changelog.js;." --add-data "css;css" --add-data "js;js" --add-data "Font;Font" --add-data "peak.ico;." main.py
if errorlevel 1 goto :fail

echo.
echo Done! Your .exe is in the dist\ folder.
pause
exit /b 0

:fail
echo.
echo [ERROR] Build failed.
pause
exit /b 1
