#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "── Detecting distro ──────────────────────"
if command -v apt &>/dev/null; then
	echo "Found: apt (Debian/Ubuntu)"
	sudo apt install -y \
		python3-gi \
		python3-gi-cairo \
		gir1.2-gtk-3.0 \
		gir1.2-webkit2-4.0

elif command -v pacman &>/dev/null; then
	echo "Found: pacman (Arch/Manjaro)"
	sudo pacman -Sy --noconfirm \
		python-gobject \
		webkit2gtk

elif command -v dnf &>/dev/null; then
	echo "Found: dnf (Fedora/RHEL)"
	sudo dnf install -y \
		python3-gobject \
		python3-gobject-base \
		webkit2gtk3

elif command -v zypper &>/dev/null; then
	echo "Found: zypper (openSUSE)"
	sudo zypper install -y \
		python3-gobject \
		typelib-1_0-WebKit2-4_0

else
	echo "ERROR: Could not detect a supported package manager."
	echo "Please manually install the GTK Python bindings for your distro."
	exit 1
fi

echo "── Setting up venv ───────────────────────"
rm -rf "$PROJECT_DIR/.venv312"
python3 -m venv --system-site-packages "$PROJECT_DIR/.venv312"

PY="$PROJECT_DIR/.venv312/bin/python"

echo "── Installing deps ───────────────────────"
$PY -m pip install --upgrade pip
$PY -m pip install -r "$PROJECT_DIR/requirements.txt"

echo "── Testing GTK is visible ────────────────"
$PY -c "import gi; print('GTK OK')" || {
	echo "ERROR: gi module still not visible. Check your system Python version matches python3-gi."
	exit 1
}

echo "── Creating launcher ─────────────────────"
sudo tee /usr/local/bin/peak >/dev/null <<EOF
#!/usr/bin/env bash
cd "$PROJECT_DIR"
"$PROJECT_DIR/.venv312/bin/python" "$PROJECT_DIR/main.py" "\$@"
EOF
sudo chmod +x /usr/local/bin/peak

echo "── Installing icon ───────────────────────"
ICON_SRC="$PROJECT_DIR/peak.png"
ICON_DEST="$HOME/.local/share/icons/hicolor/256x256/apps/peak.png"

if [ -f "$ICON_SRC" ]; then
	mkdir -p "$(dirname "$ICON_DEST")"
	cp "$ICON_SRC" "$ICON_DEST"
	gtk-update-icon-cache ~/.local/share/icons/hicolor 2>/dev/null || true
	echo "Icon installed: $ICON_DEST"
else
	echo "Warning: peak.png not found in $PROJECT_DIR, skipping icon."
	ICON_DEST=""
fi

echo "── Creating desktop entry ────────────────"
mkdir -p ~/.local/share/applications
cat >~/.local/share/applications/peak.desktop <<EOF
[Desktop Entry]
Name=Peak Video Compressor
Exec=peak
Type=Application
Terminal=false
Categories=Utility;
Icon=${ICON_DEST}
EOF

echo "── Done! ────────────────────────────────"
echo "Run with: peak"
