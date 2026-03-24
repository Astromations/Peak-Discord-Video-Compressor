@echo off
echo Installing dependencies...
pip install -r requirements.txt

echo.
echo Building .exe...
pyinstaller ^
  --onefile ^
  --windowed ^
  --name "Peak" ^
  --add-data "index.html;." ^
  --add-data "style.css;." ^
  --add-data "app.js;." ^
  main.py

echo.
echo Done! Your .exe is in the dist\ folder.
pause
