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

function resolveTauriBridge() {
  const core = window.__TAURI__?.core;
  const event = window.__TAURI__?.event;
  const internals = window.__TAURI_INTERNALS__;

  const invokeImpl =
    core?.invoke ||
    internals?.invoke ||
    (async () => {
      throw new Error("Tauri core API unavailable");
    });

  const convertImpl =
    core?.convertFileSrc || internals?.convertFileSrc || ((path) => path);

  return { invokeImpl, convertImpl, event };
}

async function invoke(cmd, args) {
  const { invokeImpl } = resolveTauriBridge();
  return invokeImpl(cmd, args);
}

function convertFileSrc(path) {
  const { convertImpl } = resolveTauriBridge();
  return convertImpl(path);
}

window.invoke = invoke;
window.convertFileSrc = convertFileSrc;
window.tauriEvent = {
  listen(eventName, handler) {
    const eventApi = resolveTauriBridge().event;
    if (!eventApi?.listen) {
      return Promise.reject(new Error("Tauri event API unavailable"));
    }
    return eventApi.listen(eventName, handler);
  },
};

function bindWindowTitlebarControls() {
  const minBtn = document.getElementById("winMinBtn");
  const maxBtn = document.getElementById("winMaxBtn");
  const closeBtn = document.getElementById("winCloseBtn");

  if (!minBtn || !maxBtn || !closeBtn) return;

  minBtn.addEventListener("click", async () => {
    try {
      await invoke("window_minimize");
    } catch (_) {}
  });

  maxBtn.addEventListener("click", async () => {
    try {
      await invoke("window_toggle_maximize");
    } catch (_) {}
  });

  closeBtn.addEventListener("click", async () => {
    try {
      await invoke("window_close");
    } catch (_) {}
  });
}

function openProjectUrl() {
  invoke("open_url", {
    url: "https://github.com/Astromations/Peak-Discord-Video-Compressor",
  }).catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
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

  buildChangelog();

  const ok = await invoke("check_ffmpeg");
  if (!ok) {
    document.getElementById("ffmpegWarning").classList.add("visible");
    setStatus("FFmpeg missing — can't compress without it", "error");
    document.getElementById("compressBtn").disabled = true;
  }
});
