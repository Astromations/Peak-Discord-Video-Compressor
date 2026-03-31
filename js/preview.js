// ════════════════════════════════════════
// PEAK — Video Compressor  |  preview.js
// ════════════════════════════════════════
// Thumbnail preview modal with Discord-like controls.

let previewItemId = null;
let previewTmpPath = null;
let previewDuration = 0;

const previewOverlay = document.getElementById("previewOverlay");
const previewVideo = document.getElementById("previewVideo");
const previewTitle = document.getElementById("previewTitle");
const previewSeek = document.getElementById("previewSeek");
const previewVolume = document.getElementById("previewVolume");
const previewTimeText = document.getElementById("previewTimeText");
const previewPlayIcon = document.getElementById("previewPlayIcon");
const previewVideoError = document.getElementById("previewVideoError");
const previewPlayerShell = document.getElementById("previewPlayerShell");
const previewFullscreenIcon = document.getElementById("previewFullscreenIcon");
const previewPrevBtn = document.getElementById("previewPrevBtn");
const previewNextBtn = document.getElementById("previewNextBtn");
const previewFsCloseBtn = document.getElementById("previewFsCloseBtn");
let previewFsCloseTimer = null;
let previewClosing = false;
let previewWindowFullscreen = false;

function _findPreviewItem(id) {
  return queue.find((i) => i.id === id) || null;
}

async function previewQueueItem(id) {
  const item = _findPreviewItem(id);
  if (!item) return;

  if (previewMode === "external") {
    try {
      await pywebview.api.open_in_media_player(item.path);
    } catch (_) {
      setStatus("Could not open default media player", "error");
    }
    return;
  }

  await openPreviewModal(item);
}

async function openPreviewModal(item) {
  await _openPreviewForItem(item, false);
}

async function _openPreviewForItem(item, autoplay) {
  if (!item) return;

  const ready =
    typeof _waitForPywebview === "function" ? await _waitForPywebview() : true;
  if (!ready) {
    setStatus("Could not connect to preview bridge — try restarting", "error");
    return;
  }

  previewItemId = item.id;
  previewDuration = 0;
  previewTitle.textContent = item.name;
  previewTimeText.textContent = "0:00 / 0:00";
  previewSeek.value = 0;
  previewVideoError.classList.remove("show");
  _updatePreviewNavButtons();

  if (previewTmpPath) {
    pywebview.api.delete_temp_file(previewTmpPath);
    previewTmpPath = null;
  }

  previewOverlay.classList.add("open");

  try {
    const result = await pywebview.api.get_mixed_preview_url(item.path);
    previewTmpPath = result?.tmp || null;
    previewVideo.src = result?.url || "";
    previewVideo.load();
    if (autoplay) {
      previewVideo.play().catch(() => {});
    }
  } catch (_) {
    previewVideoError.classList.add("show");
    setStatus("Preview failed to load", "error");
  }
}

async function _exitPreviewFullscreenIfNeeded() {
  if (previewWindowFullscreen) {
    await _setPreviewWindowFullscreen(false);
  }
  if (document.fullscreenElement === previewPlayerShell) {
    try {
      await document.exitFullscreen?.();
    } catch (_) {
      // Ignore and continue cleanup; some environments can reject if already exiting.
    }
  }
}

async function _setPreviewWindowFullscreen(enabled) {
  if (!window.pywebview?.api?.set_window_fullscreen) return false;
  try {
    const ok = await pywebview.api.set_window_fullscreen(!!enabled);
    if (!ok) return false;
    previewWindowFullscreen = !!enabled;
    _updateFullscreenIcon();
    return true;
  } catch (_) {
    return false;
  }
}

async function closePreviewModal() {
  if (previewClosing) return;
  previewClosing = true;

  _hidePreviewFsClose();
  await _exitPreviewFullscreenIfNeeded();

  previewVideo.pause();
  previewVideo.src = "";
  previewOverlay.classList.remove("open");
  previewVideoError.classList.remove("show");
  previewDuration = 0;

  if (previewTmpPath) {
    pywebview.api.delete_temp_file(previewTmpPath);
    previewTmpPath = null;
  }

  previewItemId = null;
  _updatePreviewNavButtons();
  previewClosing = false;
}

function togglePreviewPlay() {
  if (!previewVideo.src) return;
  if (previewVideo.paused) previewVideo.play();
  else previewVideo.pause();
}

function togglePreviewMute() {
  previewVideo.muted = !previewVideo.muted;
}

function openPreviewInExternal() {
  const item = _findPreviewItem(previewItemId);
  if (!item) return;
  pywebview.api.open_in_media_player(item.path);
}

async function openPreviewTrimModal() {
  if (!previewItemId || typeof openTrimModal !== "function") return;
  const targetId = previewItemId;
  await closePreviewModal();
  await openTrimModal(targetId);
}

function _setPreviewPlayIcon(playing) {
  previewPlayIcon.innerHTML = playing
    ? '<path d="M0 35.2334H10V0H0V35.2334ZM20 0V35.2334H30V0H20Z" fill="white" fill-opacity="0.6"/>'
    : `<path d="M7.5351 0.697925C4.20193 -1.26277 0 1.14049 0 5.00759V37.5235C0 41.3905 4.20193 43.7938 7.5351 41.8331L35.1737 25.5751C38.46 23.6419 38.46 18.8891 35.1737 16.9558L7.5351 0.697925Z" fill="white" fill-opacity="0.6"/>`;
}

function _getPreviewQueueIndex() {
  if (!previewItemId) return -1;
  return queue.findIndex((i) => i.id === previewItemId);
}

function _updatePreviewNavButtons() {
  const idx = _getPreviewQueueIndex();
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < queue.length - 1;

  if (previewPrevBtn) previewPrevBtn.disabled = !hasPrev;
  if (previewNextBtn) previewNextBtn.disabled = !hasNext;
}

async function _navigatePreviewClip(step) {
  const idx = _getPreviewQueueIndex();
  if (idx < 0) return;
  const nextIdx = idx + step;
  if (nextIdx < 0 || nextIdx >= queue.length) return;

  const target = queue[nextIdx];
  if (!target) return;

  const keepPlaying = !previewVideo.paused;
  await _openPreviewForItem(target, keepPlaying);
}

function previewPrevClip() {
  _navigatePreviewClip(-1);
}

function previewNextClip() {
  _navigatePreviewClip(1);
}

function _updatePreviewTime() {
  const cur = isFinite(previewVideo.currentTime) ? previewVideo.currentTime : 0;
  const dur =
    isFinite(previewDuration) && previewDuration > 0 ? previewDuration : 0;
  previewTimeText.textContent = `${fmtTimeShort(cur)} / ${fmtTimeShort(dur)}`;
  if (dur > 0) {
    previewSeek.value = ((cur / dur) * 100).toFixed(2);
  }
  _setPreviewSeekProgress();
}

function _setPreviewSeekProgress() {
  if (!previewSeek) return;
  const pct = Math.max(0, Math.min(100, parseFloat(previewSeek.value) || 0));
  previewSeek.style.setProperty("--seek-progress", `${pct}%`);
}

function togglePreviewFullscreen() {
  if (window.pywebview?.api?.set_window_fullscreen) {
    _setPreviewWindowFullscreen(!previewWindowFullscreen);
    return;
  }

  const fsEl = document.fullscreenElement;
  if (!fsEl) previewPlayerShell.requestFullscreen?.();
  else document.exitFullscreen?.();
}

function _updateFullscreenIcon() {
  const isFs =
    previewWindowFullscreen ||
    document.fullscreenElement === previewPlayerShell;
  previewOverlay?.classList.toggle("window-fullscreen", isFs);

  previewFullscreenIcon.innerHTML = isFs
    ? `<path d="M32.5051 12.5845V0H27.5051V12.5845C27.5051 13.9195 28.0319 15.1999 28.9696 16.1439C29.9073 17.0879 31.179 17.6182 32.5051 17.6182H45.005V12.5845H32.5051Z" fill="white" fill-opacity="0.6"/>
<path d="M27.5051 32.7197V45.3041H32.5051V32.7197H45.005V27.686H32.5051C31.179 27.686 29.9073 28.2163 28.9696 29.1603C28.0319 30.1043 27.5051 31.3847 27.5051 32.7197Z" fill="white" fill-opacity="0.6"/>
<path d="M12.5 12.5845H0V17.6182H12.5C13.8261 17.6182 15.0979 17.0879 16.0355 16.1439C16.9732 15.1999 17.5 13.9195 17.5 12.5845V0H12.5V12.5845Z" fill="white" fill-opacity="0.6"/>
<path d="M12.5 27.686H0V32.7197H12.5V45.3041H17.5V32.7197C17.5 31.3847 16.9732 30.1043 16.0355 29.1603C15.0979 28.2163 13.8261 27.686 12.5 27.686Z" fill="white" fill-opacity="0.6"/>`
    : `<path d="M40.0048 0H27.5048V5.0339H40.0048V17.6186H45.0047V5.0339C45.0047 3.69883 44.478 2.41843 43.5403 1.47439C42.6026 0.530355 41.3308 0 40.0048 0Z" fill="white" fill-opacity="0.6"/>
<path d="M40.0048 40.2713H27.5048V45.3052H40.0048C41.3308 45.3052 42.6026 44.7749 43.5403 43.8308C44.478 42.8868 45.0047 41.6064 45.0047 40.2713V27.6866H40.0048V40.2713Z" fill="white" fill-opacity="0.6"/>
<path d="M0 5.0339V17.6186H5V5.0339H17.5V0H5C3.67392 0 2.40215 0.530355 1.46447 1.47439C0.526784 2.41843 0 3.69883 0 5.0339Z" fill="white" fill-opacity="0.6"/>
<path d="M5 27.6866H0V40.2713C0 41.6064 0.526784 42.8868 1.46447 43.8308C2.40215 44.7749 3.67392 45.3052 5 45.3052H17.5V40.2713H5V27.6866Z" fill="white" fill-opacity="0.6"/>`;

  if (!isFs) {
    _hidePreviewFsClose();
  } else {
    _showPreviewFsClose();
  }
}

function _hidePreviewFsClose() {
  if (previewFsCloseTimer) {
    clearTimeout(previewFsCloseTimer);
    previewFsCloseTimer = null;
  }
  previewFsCloseBtn?.classList.remove("visible");
}

function _showPreviewFsClose() {
  const isFullscreen =
    previewWindowFullscreen ||
    document.fullscreenElement === previewPlayerShell;
  if (!isFullscreen || !previewFsCloseBtn) return;
  previewFsCloseBtn.classList.add("visible");
  if (previewFsCloseTimer) clearTimeout(previewFsCloseTimer);
  previewFsCloseTimer = setTimeout(() => {
    previewFsCloseBtn.classList.remove("visible");
    previewFsCloseTimer = null;
  }, 1600);
}

previewVideo.addEventListener("loadedmetadata", () => {
  previewDuration =
    isFinite(previewVideo.duration) && previewVideo.duration > 0
      ? previewVideo.duration
      : 0;
  _updatePreviewTime();
  previewVideoError.classList.remove("show");
});

previewVideo.addEventListener("timeupdate", _updatePreviewTime);
previewVideo.addEventListener("play", () => _setPreviewPlayIcon(true));
previewVideo.addEventListener("pause", () => _setPreviewPlayIcon(false));
previewVideo.addEventListener("error", () => {
  previewVideoError.classList.add("show");
});

previewVideo.addEventListener("click", togglePreviewPlay);

previewSeek.addEventListener("input", () => {
  if (!(previewDuration > 0)) return;
  previewVideo.currentTime =
    (parseFloat(previewSeek.value) / 100) * previewDuration;
  _setPreviewSeekProgress();
});

previewVolume.addEventListener("input", () => {
  previewVideo.volume = parseFloat(previewVolume.value);
  previewVideo.muted = previewVideo.volume <= 0;
});

previewVideo.addEventListener("volumechange", () => {
  if (previewVideo.muted) {
    previewVolume.value = 0;
  } else if (previewVideo.volume > 0 && parseFloat(previewVolume.value) === 0) {
    previewVolume.value = previewVideo.volume.toFixed(2);
  }
});

previewOverlay.addEventListener("click", (e) => {
  if (e.target === previewOverlay) closePreviewModal();
});

previewPlayerShell.addEventListener("mousemove", _showPreviewFsClose);
previewPlayerShell.addEventListener("pointermove", _showPreviewFsClose);

document.addEventListener("keydown", (e) => {
  if (!previewOverlay.classList.contains("open")) return;
  if (e.key === "Escape") {
    closePreviewModal();
  } else if (e.key === " ") {
    e.preventDefault();
    togglePreviewPlay();
  } else if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    togglePreviewFullscreen();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    previewPrevClip();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    previewNextClip();
  }
});

document.addEventListener("fullscreenchange", _updateFullscreenIcon);

_setPreviewSeekProgress();
