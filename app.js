// ════════════════════════════════════════
// PEAK — Video Compressor  |  app.js
// ════════════════════════════════════════
// Changelog data is loaded from changelog.js

// ── App state ─────────────────────────────────────────────────────
let queue = [];
let isRunning = false;
let customOutDir = null;
let idCounter = 0;
let currentFormat = "mp4";
const outputPaths = {};

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener("load", async () => {
  initSlider("sizeSlider", "sizeVal", (v) => `${v} MB`, 1, 200);
  initSlider("audioSlider", "audioVal", (v) => `${v} kbps`, 8, 320);
  initSlider("trimVol", null, null, 0, 1);

  buildChangelog();

  const ok = await pywebview.api.check_ffmpeg();
  if (!ok) {
    document.getElementById("ffmpegWarning").classList.add("visible");
    setStatus("FFmpeg missing — can't compress without it", "error");
    document.getElementById("compressBtn").disabled = true;
  }
});

// ── Sliders ───────────────────────────────────────────────────────
function initSlider(id, labelId, fmt, min, max) {
  const slider = document.getElementById(id);
  if (!slider) return;
  function refresh() {
    if (min !== null) {
      const pct = ((slider.value - min) / (max - min)) * 100;
      slider.style.setProperty("--val", pct + "%");
    }
    if (labelId && fmt)
      document.getElementById(labelId).textContent = fmt(
        parseFloat(slider.value),
      );
  }
  slider.addEventListener("input", refresh);
  if (id === "trimVol") {
    slider.addEventListener("input", () => {
      const v = document.getElementById("trimVideo");
      if (v) v.volume = parseFloat(slider.value);
    });
  }
  refresh();
}

function resetSettings() {
  document.getElementById("sizeSlider").value = 10;
  document.getElementById("audioSlider").value = 128;
  document.getElementById("sizeSlider").dispatchEvent(new Event("input"));
  document.getElementById("audioSlider").dispatchEvent(new Event("input"));
  document.getElementById("gpuToggle").checked = false;
  document.getElementById("combineAudioToggle").checked = true;
  document.getElementById("twoPassToggle").checked = true;
  selectFmt(document.querySelector('.fmt-option[data-value="mp4"]'));
  document.getElementById("outputDirToggle").checked = false;
  document.getElementById("outputDirPicker").classList.remove("visible");
  document.getElementById("outputDirSubtitle").textContent =
    "Off — saves next to source file";
  customOutDir = null;
}

// ── Toggles ───────────────────────────────────────────────────────
function toggleCb(id) {
  document.getElementById(id).checked = !document.getElementById(id).checked;
}

let _outputDirToggling = false;
function toggleOutputDir() {
  if (_outputDirToggling) return;
  _outputDirToggling = true;
  setTimeout(() => {
    _outputDirToggling = false;
  }, 50);
  const cb = document.getElementById("outputDirToggle");
  cb.checked = !cb.checked;
  document
    .getElementById("outputDirPicker")
    .classList.toggle("visible", cb.checked);
  document.getElementById("outputDirSubtitle").textContent = cb.checked
    ? customOutDir
      ? shortPath(customOutDir)
      : "Select a folder below"
    : "Off — saves next to source file";
}

async function pickDirectory() {
  const dir = await pywebview.api.pick_directory();
  if (dir) {
    customOutDir = dir;
    document.getElementById("dirPathLabel").textContent = dir;
    document.getElementById("dirPathLabel").classList.add("set");
    document.getElementById("outputDirSubtitle").textContent = shortPath(dir);
  }
}

function shortPath(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

// ── Format dropdown ───────────────────────────────────────────────
function toggleFmtMenu(e) {
  e.stopPropagation();
  const btn = document.getElementById("fmtBtn");
  const menu = document.getElementById("fmtMenu");
  const open = menu.classList.toggle("open");
  btn.classList.toggle("open", open);
}

function selectFmt(el) {
  currentFormat = el.dataset.value;
  document
    .querySelectorAll(".fmt-option")
    .forEach((o) => o.classList.remove("selected"));
  el.classList.add("selected");
  document.getElementById("fmtBtnLabel").textContent =
    currentFormat === "original" ? "Original" : currentFormat.toUpperCase();
  document.getElementById("fmtMenu").classList.remove("open");
  document.getElementById("fmtBtn").classList.remove("open");
}

document.addEventListener("click", () => {
  document.getElementById("fmtMenu")?.classList.remove("open");
  document.getElementById("fmtBtn")?.classList.remove("open");
});

// ── File browsing / drag-drop ─────────────────────────────────────
async function browseFiles() {
  if (isRunning) return;
  const paths = await pywebview.api.open_file_dialog();
  for (const p of paths) addToQueue(p);
}

const dz = document.getElementById("dropZone");
dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("hover");
});
dz.addEventListener("dragleave", () => dz.classList.remove("hover"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("hover");
  if (isRunning) return;
  const files = Array.from(e.dataTransfer.files);
  for (const f of files) {
    // f.path is available in some webview/Electron environments;
    // fall back to pywebview API to resolve the full path from the filename.
    let fullPath = f.path;
    if (!fullPath || fullPath === f.name) {
      try {
        fullPath = await pywebview.api.resolve_dropped_path(f.name);
      } catch (_) {
        fullPath = f.name;
      }
    }
    if (fullPath) addToQueue(fullPath);
  }
});

// ── Queue management ──────────────────────────────────────────────
function addToQueue(path) {
  const id = `qi-${++idCounter}`;
  const name = path.split(/[/\\]/).pop();
  queue.push({
    id,
    path,
    name,
    status: "waiting",
    trimStart: "",
    trimEnd: "",
    enabledTracks: null,
    audioTracks: [],
  });
  renderQueueItem(id, name, path);
  updateCompressBtn();

  pywebview.api.get_thumbnail(path).then((uri) => {
    const t = document.querySelector(`#${id} .qi-thumb`);
    if (t)
      t.innerHTML = uri ? `<img src="${uri}" alt="" />` : thumbPlaceholder();
  });
}

function removeFromQueue(id) {
  queue = queue.filter((i) => i.id !== id);
  document.getElementById(id)?.remove();
  updateQueueEmpty();
  updateCompressBtn();
}

function updateQueueEmpty() {
  document.getElementById("queueEmpty").style.display =
    queue.length === 0 ? "flex" : "none";
}

function updateCompressBtn() {
  const waiting = queue.filter((i) => i.status === "waiting").length;
  const btn = document.getElementById("compressBtn");
  const label = document.getElementById("compressBtnLabel");
  updateQueueEmpty();
  if (isRunning) {
    btn.disabled = true;
    label.textContent = "Compressing…";
    return;
  }
  btn.disabled = waiting === 0;
  label.textContent =
    waiting === 1
      ? "Compress 1 file"
      : waiting > 1
        ? `Compress ${waiting} files`
        : "Compress";
}

function renderQueueItem(id, name, path) {
  const wrap = document.getElementById("queueWrap");
  const empty = document.getElementById("queueEmpty");
  const el = document.createElement("div");
  el.className = "qi";
  el.id = id;
  el.innerHTML = `
    <div class="qi-main">
      <div class="qi-thumb"><div class="thumb-spinner"></div></div>
      <div class="qi-body">
        <button class="qi-name qi-name-link" title="Reveal in explorer" onclick="revealSourceFile('${esc(path)}')">${esc(name)}</button>
        <div class="qi-status-row" id="${id}-status">
          <span class="chip chip-waiting">Waiting</span>
        </div>
      </div>
      <div class="qi-actions">
        <button class="qi-btn trim-btn" id="${id}-trimbtn" onclick="openTrimModal('${id}')" title="Trim / preview">✂</button>
        <button class="qi-btn remove" onclick="removeFromQueue('${id}')" title="Remove">✕</button>
      </div>
    </div>`;
  wrap.insertBefore(el, empty);
  empty.style.display = "none";
}

// ── Queue runner ──────────────────────────────────────────────────
function startQueue() {
  if (isRunning || !queue.some((i) => i.status === "waiting")) return;
  isRunning = true;
  document.getElementById("progressTrack").classList.add("visible");
  updateCompressBtn();
  processNext();
}

function processNext() {
  const next = queue.find((i) => i.status === "waiting");
  if (!next) {
    isRunning = false;
    document.getElementById("progressTrack").classList.remove("visible");
    const done = queue.filter((i) => i.status === "done").length;
    setStatus(
      `✓ Done — ${done} file${done !== 1 ? "s" : ""} compressed`,
      "success",
    );
    updateCompressBtn();
    return;
  }
  next.status = "compressing";
  setItemCompressing(next.id);
  setStatus(`Compressing: ${next.name}`, "working");

  pywebview.api.compress(
    next.id,
    next.path,
    parseInt(document.getElementById("sizeSlider").value),
    parseInt(document.getElementById("audioSlider").value),
    document.getElementById("gpuToggle").checked,
    document.getElementById("combineAudioToggle").checked,
    document.getElementById("twoPassToggle").checked,
    document.getElementById("outputDirToggle").checked && customOutDir
      ? customOutDir
      : null,
    currentFormat,
    next.trimStart || "",
    next.trimEnd || "",
    next.enabledTracks,
  );
}

// ── Item state renderers ──────────────────────────────────────────
function setItemCompressing(id) {
  const sr = document.getElementById(`${id}-status`);
  if (sr)
    sr.innerHTML = `
    <span class="chip chip-pass1">Pass 1</span>
    <div class="qi-progress">
      <div class="qi-bar-track"><div class="qi-bar-fill" id="${id}-fill"></div></div>
      <span class="qi-eta" id="${id}-eta">Starting…</span>
    </div>`;
  document
    .querySelectorAll(`#${id} .qi-btn`)
    .forEach((b) => (b.disabled = true));
}

function onItemProgress(id, progress, eta) {
  const fill = document.getElementById(`${id}-fill`);
  const etaEl = document.getElementById(`${id}-eta`);
  const main = document.querySelector(`#${id} .qi-main`);
  const chip = document.querySelector(`#${id}-status .chip`);
  if (fill) fill.style.width = (progress * 100).toFixed(1) + "%";
  if (main)
    main.style.setProperty("--row-progress", (progress * 100).toFixed(1) + "%");
  const twoPass = document.getElementById("twoPassToggle").checked;
  if (chip) {
    if (twoPass && progress < 0.5) {
      chip.textContent = "Pass 1";
      if (etaEl) etaEl.textContent = "Analyzing…";
    } else {
      chip.textContent = twoPass ? "Pass 2" : "Encoding";
      if (etaEl)
        etaEl.textContent = eta !== null ? fmtEta(eta) : "Calculating…";
    }
  }
}

function onItemDone(id, outputPath) {
  const item = queue.find((i) => i.id === id);
  if (item) item.status = "done";
  outputPaths[id] = outputPath;
  const main = document.querySelector(`#${id} .qi-main`);
  if (main) main.style.setProperty("--row-progress", "100%");
  const sr = document.getElementById(`${id}-status`);
  if (sr) {
    const name = outputPath.split(/[/\\]/).pop();
    sr.innerHTML = `
      <span class="chip chip-done">✓ Done</span>
      <button class="qi-file-link" id="${id}-outlink" onclick="openOutputFile('${id}')" title="${esc(outputPath)}">${esc(name)}</button>
      <button class="qi-rename-btn" onclick="renameFile('${id}')" title="Rename output file">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>`;
  }
  document
    .querySelectorAll(`#${id} .qi-btn`)
    .forEach((b) => (b.disabled = false));
  processNext();
}

function showRenameDialog(defaultStem, ext) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "rename-overlay";
    overlay.innerHTML = `
      <div class="rename-card" role="dialog" aria-modal="true" aria-label="Rename output file">
        <div class="rename-header">Rename output file</div>
        <div class="rename-body">
          <label class="rename-label" for="renameInput">New filename</label>
          <div class="rename-input-wrap">
            <input id="renameInput" class="rename-input" type="text" value="${esc(defaultStem)}" />
            <span class="rename-ext">${esc(ext)}</span>
          </div>
          <div class="rename-error" id="renameError"></div>
        </div>
        <div class="rename-footer">
          <button class="rename-btn cancel" id="renameCancelBtn">Cancel</button>
          <button class="rename-btn apply" id="renameApplyBtn">Rename</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.querySelector(".rename-card");
    const input = overlay.querySelector("#renameInput");
    const err = overlay.querySelector("#renameError");
    const cancelBtn = overlay.querySelector("#renameCancelBtn");
    const applyBtn = overlay.querySelector("#renameApplyBtn");

    function close(value) {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      resolve(value);
    }

    function validateAndSubmit() {
      const val = input.value.trim();
      if (!val) {
        err.textContent = "Filename cannot be empty.";
        input.focus();
        return;
      }
      if (/[<>:"/\\\\|?*]/.test(val)) {
        err.textContent = "Filename contains invalid characters.";
        input.focus();
        return;
      }
      close(val);
    }

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        validateAndSubmit();
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    cancelBtn.addEventListener("click", () => close(null));
    applyBtn.addEventListener("click", validateAndSubmit);
    input.addEventListener("input", () => (err.textContent = ""));
    document.addEventListener("keydown", onKeydown, true);

    setTimeout(() => {
      card.classList.add("open");
      input.focus();
      input.select();
    }, 0);
  });
}

function showRenameErrorDialog(message) {
  const overlay = document.createElement("div");
  overlay.className = "rename-overlay";
  overlay.innerHTML = `
    <div class="rename-card rename-error-card open" role="alertdialog" aria-modal="true" aria-label="Rename error">
      <div class="rename-header">Rename failed</div>
      <div class="rename-body">
        <div class="rename-error show">${esc(message)}</div>
      </div>
      <div class="rename-footer">
        <button class="rename-btn apply" id="renameErrorOkBtn">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  }

  function onKeydown(e) {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      close();
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("#renameErrorOkBtn")?.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown, true);
}

async function renameFile(id) {
  const oldPath = outputPaths[id];
  if (!oldPath) return;

  const oldName = oldPath.split(/[/\\]/).pop();
  const dotIdx = oldName.lastIndexOf(".");
  const ext = dotIdx > 0 ? oldName.substring(dotIdx) : "";
  const stem = dotIdx > 0 ? oldName.substring(0, dotIdx) : oldName;

  const newStem = await showRenameDialog(stem, ext);
  if (!newStem || newStem === stem) return;

  const newName = newStem + ext;
  try {
    const newPath = await pywebview.api.rename_file(oldPath, newName);
    if (!newPath) {
      showRenameErrorDialog(
        "Could not rename file. A file with that name may already exist.",
      );
      return;
    }
    outputPaths[id] = newPath;
    const link = document.getElementById(`${id}-outlink`);
    if (link) {
      link.textContent = newName;
      link.title = newPath;
    }
  } catch (e) {
    showRenameErrorDialog("Rename failed: " + (e.message || e));
  }
}

function onItemError(id, msg) {
  const item = queue.find((i) => i.id === id);
  if (item) item.status = "error";
  const main = document.querySelector(`#${id} .qi-main`);
  if (main) main.style.removeProperty("--row-progress");
  const sr = document.getElementById(`${id}-status`);
  if (sr)
    sr.innerHTML = `<span class="chip chip-error">✗ Error</span><span style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px" title="${esc(msg)}">${esc(msg)}</span>`;
  document
    .querySelectorAll(`#${id} .qi-btn`)
    .forEach((b) => (b.disabled = false));
  processNext();
}

function openOutputFile(id) {
  const path = outputPaths[id];
  if (path) pywebview.api.open_file(path);
}

function revealSourceFile(path) {
  if (path) pywebview.api.open_file(path);
}

// ════════════════════════════════════════
// TRIM MODAL
// ════════════════════════════════════════

let trimItemId = null;
let trimDuration = 0;
let trimIn = 0;
let trimOut = 0;
let trimDragging = null; // 'in' | 'out' | null
let trimAudioTracks = [];
let trimEnabledTracks = null; // null = all, or Set of indices (export selection)
let trimPreviewTmp = null; // temp file path created for mixed-audio preview

const trimVideo = document.getElementById("trimVideo");
const tlTrack = document.getElementById("tlTrack");
const tlHandleIn = document.getElementById("tlHandleIn");
const tlHandleOut = document.getElementById("tlHandleOut");
const tlPlayhead = document.getElementById("tlPlayhead");
const tlSelection = document.getElementById("tlSelection");

async function openTrimModal(id) {
  const item = queue.find((i) => i.id === id);
  if (!item) return;

  trimItemId = id;
  trimIn = item.trimStart ? parseTimeJS(item.trimStart) : 0;
  trimOut = item.trimEnd ? parseTimeJS(item.trimEnd) : -1; // -1 = end (resolved after metadata)
  trimAudioTracks = item.audioTracks || [];
  trimEnabledTracks = item.enabledTracks ? new Set(item.enabledTracks) : null;

  document.getElementById("trimModalTitle").textContent = item.name;

  // Reset UI to loading state — avoids showing stale -1:-1 values
  document.getElementById("trimTotalTime").textContent = "–:––";
  document.getElementById("trimCurrentTime").textContent = "0:00.000";
  document.getElementById("trimInInput").value = "";
  document.getElementById("trimOutInput").value = "";
  document.getElementById("trimVideoError").classList.remove("show");

  // Reset timeline
  trimDuration = 0;
  tlHandleIn.style.left = "0%";
  tlHandleOut.style.left = "100%";
  tlSelection.style.left = "0%";
  tlSelection.style.width = "100%";
  tlPlayhead.style.left = "0%";
  document.getElementById("tlLabelIn").textContent = "0:00";
  document.getElementById("tlLabelOut").textContent = "–:––";

  document.getElementById("trimOverlay").classList.add("open");

  // Load via localhost HTTP server (works on all pywebview backends).
  // If the file has multiple audio tracks, mix them down to a temp file first
  // so all tracks are audible simultaneously during preview (Chromium only
  // exposes one audio stream natively from a multi-track container).
  trimPreviewTmp = null;
  const result = await pywebview.api.get_mixed_preview_url(item.path);
  trimPreviewTmp = result.tmp; // null if single-track or fallback
  trimVideo.src = result.url;
  trimVideo.load();

  // Fetch audio tracks if not yet loaded
  if (trimAudioTracks.length === 0) {
    pywebview.api.get_audio_tracks(item.path).then((tracks) => {
      trimAudioTracks = tracks;
      item.audioTracks = tracks;
      renderAudioTracks();
    });
  } else {
    renderAudioTracks();
  }
}

trimVideo.addEventListener("loadedmetadata", () => {
  trimDuration =
    isFinite(trimVideo.duration) && trimVideo.duration > 0
      ? trimVideo.duration
      : 0;

  if (trimOut < 0 || trimOut > trimDuration) trimOut = trimDuration;
  if (trimIn > trimDuration) trimIn = 0;

  document.getElementById("trimTotalTime").textContent =
    fmtTimeFull(trimDuration);
  document.getElementById("trimInInput").value = fmtTimeFull(trimIn);
  document.getElementById("trimOutInput").value = fmtTimeFull(trimOut);
  document.getElementById("trimVideoError").classList.remove("show");
  updateTimeline();
  seekTrimVideo(trimIn);
});

trimVideo.addEventListener("error", () => {
  // Show error overlay if video truly fails to load
  document.getElementById("trimVideoError").classList.add("show");
});

trimVideo.addEventListener("timeupdate", () => {
  const t = trimVideo.currentTime;
  document.getElementById("trimCurrentTime").textContent = fmtTimeFull(t);
  if (trimDuration > 0) {
    tlPlayhead.style.left = (t / trimDuration) * 100 + "%";
  }
  // Loop within trim range when playing
  if (!trimVideo.paused && t >= trimOut - 0.05) {
    trimVideo.currentTime = trimIn;
  }
});

trimVideo.addEventListener("play", updatePlayBtn);
trimVideo.addEventListener("pause", updatePlayBtn);

function updatePlayBtn() {
  const playing = !trimVideo.paused;
  const icon = document.getElementById("trimPlayIcon");
  icon.innerHTML = playing
    ? '<rect x="6" y="4" width="4" height="16" rx="1" fill="white"/><rect x="14" y="4" width="4" height="16" rx="1" fill="white"/>'
    : '<path d="M5 3l14 9-14 9V3z" fill="white"/>';
  showPlayOverlay(playing ? "pause" : "play");
}

function showPlayOverlay(type) {
  const overlay = document.getElementById("trimPlayOverlay");
  const icon = document.getElementById("trimPlayOverlayIcon");
  icon.innerHTML =
    type === "play"
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M5 3l14 9-14 9V3z"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  overlay.classList.add("show");
  setTimeout(() => overlay.classList.remove("show"), 500);
}

function toggleTrimPlay() {
  if (trimDuration <= 0) return;
  if (trimVideo.paused) {
    if (trimVideo.currentTime >= trimOut - 0.05) trimVideo.currentTime = trimIn;
    trimVideo.play();
  } else {
    trimVideo.pause();
  }
}

function skipVideo(secs) {
  trimVideo.currentTime = Math.max(
    0,
    Math.min(trimDuration, trimVideo.currentTime + secs),
  );
}

function seekTrimVideo(t) {
  trimVideo.currentTime = Math.max(0, Math.min(trimDuration || 0, t));
}

// ── Timeline drag ─────────────────────────────────────────────────

function getTrackFrac(e) {
  const rect = tlTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

tlTrack.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  tlTrack.setPointerCapture(e.pointerId);
  if (trimDuration <= 0) return;
  const frac = getTrackFrac(e);
  const inFrac = trimIn / trimDuration;
  const outFrac = trimOut / trimDuration;
  const hitZone = 0.03;

  if (Math.abs(frac - inFrac) < hitZone) {
    trimDragging = "in";
    tlHandleIn.classList.add("dragging");
  } else if (Math.abs(frac - outFrac) < hitZone) {
    trimDragging = "out";
    tlHandleOut.classList.add("dragging");
  } else {
    seekTrimVideo(frac * trimDuration);
  }
});

tlTrack.addEventListener("pointermove", (e) => {
  if (!trimDragging) return;
  const t = getTrackFrac(e) * trimDuration;
  if (trimDragging === "in") {
    trimIn = Math.max(0, Math.min(t, trimOut - 0.1));
    document.getElementById("trimInInput").value = fmtTimeFull(trimIn);
    seekTrimVideo(trimIn);
  } else {
    trimOut = Math.min(trimDuration, Math.max(t, trimIn + 0.1));
    document.getElementById("trimOutInput").value = fmtTimeFull(trimOut);
    seekTrimVideo(trimOut);
  }
  updateTimeline();
});

tlTrack.addEventListener("pointerup", () => {
  if (trimDragging) {
    tlHandleIn.classList.remove("dragging");
    tlHandleOut.classList.remove("dragging");
    trimDragging = null;
    updateTimelineLabels();
  }
});

function updateTimeline() {
  if (trimDuration <= 0) return;
  const inPct = ((trimIn / trimDuration) * 100).toFixed(3) + "%";
  const outPct = ((trimOut / trimDuration) * 100).toFixed(3) + "%";
  tlHandleIn.style.left = inPct;
  tlHandleOut.style.left = outPct;
  tlSelection.style.left = inPct;
  tlSelection.style.width =
    (((trimOut - trimIn) / trimDuration) * 100).toFixed(3) + "%";
  updateTimelineLabels();
}

function updateTimelineLabels() {
  document.getElementById("tlLabelIn").textContent = fmtTimeShort(trimIn);
  document.getElementById("tlLabelOut").textContent = fmtTimeShort(trimOut);
}

// ── Trim input fields ─────────────────────────────────────────────

document.getElementById("trimInInput").addEventListener("change", (e) => {
  const t = parseTimeJS(e.target.value);
  if (t !== null && t >= 0 && t < trimOut) {
    trimIn = Math.max(0, t);
    e.target.value = fmtTimeFull(trimIn);
    updateTimeline();
    seekTrimVideo(trimIn);
  } else {
    e.target.value = fmtTimeFull(trimIn); // revert
  }
});

document.getElementById("trimOutInput").addEventListener("change", (e) => {
  const t = parseTimeJS(e.target.value);
  if (t !== null && t > trimIn) {
    trimOut = Math.min(trimDuration, t);
    e.target.value = fmtTimeFull(trimOut);
    updateTimeline();
    seekTrimVideo(trimOut);
  } else {
    e.target.value = fmtTimeFull(trimOut); // revert
  }
});

// Allow text selection inside inputs
["trimInInput", "trimOutInput"].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("click", (e) => e.stopPropagation());
  el.addEventListener("mousedown", (e) => e.stopPropagation());
});

function setPointToCurrent(which) {
  const t = trimVideo.currentTime;
  if (which === "in") {
    trimIn = Math.max(0, Math.min(t, trimOut - 0.1));
    document.getElementById("trimInInput").value = fmtTimeFull(trimIn);
  } else {
    trimOut = Math.min(trimDuration, Math.max(t, trimIn + 0.1));
    document.getElementById("trimOutInput").value = fmtTimeFull(trimOut);
  }
  updateTimeline();
}

// ── Audio tracks ──────────────────────────────────────────────────
// Note: Chromium (pywebview's engine) does not implement HTMLMediaElement.audioTracks,
// so per-track preview isolation is not possible. Toggles here affect export only.

function renderAudioTracks() {
  const section = document.getElementById("trimAudioSection");
  const list = document.getElementById("trimTrackList");

  if (!trimAudioTracks || trimAudioTracks.length === 0) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  list.innerHTML = "";

  trimAudioTracks.forEach((track) => {
    const exportEnabled =
      trimEnabledTracks === null || trimEnabledTracks.has(track.index);
    // Filter out uninformative "und" (undetermined) language tag
    const parts = [
      track.codec,
      track.channels,
      track.language && track.language !== "und" ? track.language : null,
      track.title,
    ].filter(Boolean);
    const meta = parts.join(" · ");

    const row = document.createElement("div");
    row.className = "trim-track" + (exportEnabled ? " on" : "");
    row.dataset.index = track.index;
    row.innerHTML = `
      <div class="trim-track-check">
        <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3l2 2 4-4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="trim-track-info">
        <div class="trim-track-name">Track ${track.index + 1}</div>
        <div class="trim-track-meta">${esc(meta) || "No metadata"}</div>
      </div>`;

    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.index);
      if (trimEnabledTracks === null) {
        trimEnabledTracks = new Set(
          trimAudioTracks.map((t) => t.index).filter((i) => i !== idx),
        );
      } else {
        if (trimEnabledTracks.has(idx)) {
          trimEnabledTracks.delete(idx);
        } else {
          trimEnabledTracks.add(idx);
          if (trimEnabledTracks.size === trimAudioTracks.length)
            trimEnabledTracks = null;
        }
      }
      row.classList.toggle(
        "on",
        trimEnabledTracks === null || trimEnabledTracks.has(idx),
      );
    });

    list.appendChild(row);
  });
}

// ── Apply / close ─────────────────────────────────────────────────

function applyTrim() {
  const item = queue.find((i) => i.id === trimItemId);
  if (!item) {
    closeTrimModal();
    return;
  }

  const inIsZero = trimIn <= 0.001;
  const outIsEnd = Math.abs(trimOut - trimDuration) <= 0.1;

  item.trimStart = inIsZero ? "" : fmtTimeFull(trimIn);
  item.trimEnd = outIsEnd ? "" : fmtTimeFull(trimOut);
  item.enabledTracks =
    trimEnabledTracks === null ? null : [...trimEnabledTracks];
  item.audioTracks = trimAudioTracks;

  const statusRow = document.getElementById(`${trimItemId}-status`);
  const badge = statusRow?.querySelector(".qi-trim-badge");
  const hasTrim = !inIsZero || !outIsEnd;
  const hasTrackFilter = trimEnabledTracks !== null;

  if (hasTrim || hasTrackFilter) {
    const badgeText = [
      hasTrim ? `${fmtTimeShort(trimIn)}–${fmtTimeShort(trimOut)}` : null,
      hasTrackFilter
        ? `${trimEnabledTracks.size}/${trimAudioTracks.length} tracks`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (badge) {
      badge.textContent = badgeText;
    } else {
      const b = document.createElement("span");
      b.className = "qi-trim-badge";
      b.textContent = badgeText;
      statusRow?.appendChild(b);
    }
    document.getElementById(`${trimItemId}-trimbtn`)?.classList.add("active");
  } else {
    badge?.remove();
    document
      .getElementById(`${trimItemId}-trimbtn`)
      ?.classList.remove("active");
  }

  closeTrimModal();
}

function closeTrimModal() {
  trimVideo.pause();
  trimVideo.src = "";
  document.getElementById("trimOverlay").classList.remove("open");
  if (trimPreviewTmp) {
    pywebview.api.delete_temp_file(trimPreviewTmp);
    trimPreviewTmp = null;
  }
  trimItemId = null;
}

document.getElementById("trimOverlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("trimOverlay")) closeTrimModal();
});

// ════════════════════════════════════════
// CHANGELOG MODAL
// ════════════════════════════════════════

function buildChangelog() {
  const body = document.getElementById("changelogBody");
  body.innerHTML = "";

  CHANGELOG.forEach((entry, idx) => {
    const block = document.createElement("div");
    block.className = "cl-version";

    const hdr = document.createElement("div");
    hdr.className = "cl-version-header";
    hdr.innerHTML =
      `<span class="cl-version-tag">${esc(entry.version)}</span>` +
      `<span class="cl-version-date">${esc(entry.date)}</span>` +
      (entry.latest ? `<span class="cl-version-latest">Latest</span>` : "");
    block.appendChild(hdr);

    const ul = document.createElement("ul");
    ul.className = "cl-changes";
    entry.changes.forEach((c) => {
      const li = document.createElement("li");
      li.textContent = c;
      ul.appendChild(li);
    });
    block.appendChild(ul);

    if (idx < CHANGELOG.length - 1) {
      const hr = document.createElement("hr");
      hr.className = "cl-divider";
      block.appendChild(hr);
    }

    body.appendChild(block);
  });
}

function openChangelog() {
  document.getElementById("changelogOverlay").classList.add("open");
}

function closeChangelog() {
  document.getElementById("changelogOverlay").classList.remove("open");
}

document.getElementById("changelogOverlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("changelogOverlay"))
    closeChangelog();
});

// ════════════════════════════════════════
// Helpers
// ════════════════════════════════════════

function fmtTimeFull(s) {
  if (!isFinite(s) || s < 0) return "0:00.000";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return `${m}:${sec}`;
}

function fmtTimeShort(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${sec}`;
}

function parseTimeJS(s) {
  s = String(s).trim();
  if (!s) return null;
  const parts = s.split(":");
  try {
    if (parts.length === 3)
      return (
        parseInt(parts[0]) * 3600 +
        parseInt(parts[1]) * 60 +
        parseFloat(parts[2])
      );
    if (parts.length === 2)
      return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(s);
  } catch {
    return null;
  }
}

function fmtEta(secs) {
  secs = Math.round(secs);
  if (secs < 5) return "Almost done";
  if (secs < 60) return `ETA ${secs}s`;
  return `ETA ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function setStatus(msg, type) {
  const el = document.getElementById("statusText");
  el.textContent = msg;
  el.className = "status-text" + (type ? ` ${type}` : "");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function thumbPlaceholder() {
  return `<svg class="qi-thumb-placeholder" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 10L19.5528 7.72361C20.2177 7.39116 21 7.87465 21 8.61803V15.382C21 16.1253 20.2177 16.6088 19.5528 16.2764L15 14M5 18H13C14.1046 18 15 17.1046 15 16V8C15 6.89543 14.1046 6 13 6H5C3.89543 6 3 6.89543 3 8V16C3 17.1046 3.89543 18 5 18Z" stroke="#949ba4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
