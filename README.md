# Peak - Discord Video Compressor

A Discord-styled video compressor. Drop a video in, pick your target size, and get a compressed `.mp4` back.

---

## Files

```
main.py          ← Python backend (FFmpeg logic + pywebview API)
index.html       ← Discord UI (HTML/CSS/JS)
requirements.txt ← Python dependencies
build.bat        ← One-click build to .exe (Windows)
build.sh         ← Install script for Linux
```

---

## Running from source

1. **Install FFmpeg** and make sure `ffmpeg` and `ffprobe` are in your PATH.
   - Windows
	   - Download: https://ffmpeg.org/download.html
	   - extract → add the `bin/` folder to PATH → restart terminal
   - Linux
	   - Arch:        `sudo pacman -S ffmpeg`
	   - Ubuntu:   `sudo apt install ffmpeg`
	   - Fedora:    `sudo dnf install ffmpeg`
	   
2. **Install Python dependencies**

   ```
   pip install -r requirements.txt
   ```

3. **Run**
   ```
   python main.py
   ```

---

## Building the .exe

Double-click `build.bat`, or run it from a terminal:

```
build.bat
```

Your `.exe` will appear in the `dist/` folder. Share `Peak.exe` with your friends — they only need FFmpeg installed separately (it can't be bundled due to its license).

---

## Building on Linux 

Run the provided build script from your terminal:
```bash
chmod +x build.sh
./build.sh
```
This will:
- Install GTK dependencies for your distro (apt, pacman, dnf, or zypper)
- Set up a Python virtual environment
- Install Python dependencies
- Create a `peak` command you can run from anywhere

**Warning:**
 The project folder must stay in place after building — the launcher points to it directly.

## Notes

- The output file is saved next to the original, with `_compressed` added to the name.
- GPU encoding (NVENC) requires an NVIDIA GPU. Uncheck it if you don't have one.
- Audio bitrate defaults to 128 kbps — good for most Discord sharing.

``` Ample help from Claude ```
