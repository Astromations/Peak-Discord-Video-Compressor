@echo off
setlocal

echo [Peak] Building Tauri app...

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Rust/Cargo was not found in PATH.
  echo Install Rust from https://rustup.rs/ and reopen the terminal.
  pause
  exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ffmpeg was not found in PATH.
  echo Install FFmpeg and ensure ffmpeg and ffprobe are available before building.
  pause
  exit /b 1
)

where ffprobe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ffprobe was not found in PATH.
  echo Install FFmpeg and ensure ffmpeg and ffprobe are available before building.
  pause
  exit /b 1
)

echo [Peak] Staging custom font...
if not exist "src\Font" mkdir "src\Font"
copy /Y "Font\style.css" "src\Font\style.css" >nul
copy /Y "Font\ggsans-Normal.woff2" "src\Font\ggsans-Normal.woff2" >nul
copy /Y "Font\ggsans-Normal.woff" "src\Font\ggsans-Normal.woff" >nul
copy /Y "Font\ggsans-Normal.ttf" "src\Font\ggsans-Normal.ttf" >nul
if errorlevel 1 (
  echo [ERROR] Could not stage the custom font files.
  pause
  exit /b 1
)

cargo tauri build
if errorlevel 1 (
  echo.
  echo [ERROR] Tauri build failed.
  pause
  exit /b 1
)

echo.
echo [OK] Build complete. Output is in the target\release\bundle folder.
pause
exit /b 0
