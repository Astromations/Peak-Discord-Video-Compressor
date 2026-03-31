// ════════════════════════════════════════
// PEAK — Video Compressor  |  app.js
// ════════════════════════════════════════
// Entry point: shared state and initialisation.
//
// Module load order (defined in index.html):
//   changelog.js  → js/helpers.js → js/sliders.js → js/settings.js
//   → js/queue.js → js/compressor.js → js/trim.js → js/changelog.js
//   → app.js (this file)

// ── Shared app state (used across modules) ────────────────────────
let queue = [];
let isRunning = false;
let cancelRequested = false;
let sessionPaused = false;
let customOutDir = null;
let idCounter = 0;
let currentFormat = "mp4";
let previewMode = "internal";
const outputPaths = {};

function bindWindowTitlebarControls() {
  const minBtn = document.getElementById("winMinBtn");
  const maxBtn = document.getElementById("winMaxBtn");
  const closeBtn = document.getElementById("winCloseBtn");

  if (!minBtn || !maxBtn || !closeBtn) return;

  minBtn.addEventListener("click", async () => {
    if (!window.pywebview?.api?.window_minimize) return;
    try {
      await window.pywebview.api.window_minimize();
    } catch (_) {}
  });

  maxBtn.addEventListener("click", async () => {
    if (!window.pywebview?.api?.window_toggle_maximize) return;
    try {
      await window.pywebview.api.window_toggle_maximize();
    } catch (_) {}
  });

  closeBtn.addEventListener("click", async () => {
    if (!window.pywebview?.api?.window_close) return;
    try {
      await window.pywebview.api.window_close();
    } catch (_) {}
  });
}

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener("load", async () => {
  bindWindowTitlebarControls();

  initSlider("sizeSlider", "sizeVal", (v) => `${v} MB`, 1, 200);
  initSlider("audioSlider", "audioVal", (v) => `${v} kbps`, 8, 320);
  initSlider("trimVol", null, null, 0, 1);

  // Load persistent settings after sliders init
  setTimeout(async () => {
    if (typeof loadSettings === "function") {
      await loadSettings();
    }
  }, 0);

  // Ensure persisted settings are applied once the pywebview bridge is ready.
  window.addEventListener(
    "pywebviewready",
    async () => {
      if (typeof loadSettings === "function") {
        await loadSettings();
      }
    },
    { once: true },
  );

  buildChangelog();

  const ok = await pywebview.api.check_ffmpeg();
  if (!ok) {
    document.getElementById("ffmpegWarning").classList.add("visible");
    setStatus("FFmpeg missing — can't compress without it", "error");
    document.getElementById("compressBtn").disabled = true;
  }
});
