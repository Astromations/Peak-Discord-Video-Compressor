// ════════════════════════════════════════
// PEAK — Video Compressor  |  queue.js
// ════════════════════════════════════════
// Queue management, file browsing, and drag-drop.

// ── File browsing / drag-drop ─────────────────────────────────────

// pywebview fires "pywebviewready" when its JS bridge is fully initialised.
// We gate open_file_dialog on this event so the promise never hangs silently.
let _pywebviewReady = false;
let queueViewMode = "list";
let dragSourceId = null;
let dragHandleArmedId = null;
window.addEventListener("pywebviewready", () => {
  _pywebviewReady = true;
});

async function _waitForPywebview(timeoutMs = 5000) {
  if (_pywebviewReady) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    window.addEventListener(
      "pywebviewready",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

async function browseFiles() {
  if (isRunning) return;
  const ready = await _waitForPywebview();
  if (!ready) {
    setStatus("Could not connect to file dialog — try restarting", "error");
    return;
  }
  let paths;
  try {
    paths = await pywebview.api.open_file_dialog();
  } catch (err) {
    setStatus("File dialog error: " + (err.message || err), "error");
    return;
  }
  // Normalise: some backends return null/undefined on cancel instead of []
  if (!Array.isArray(paths)) return;
  for (const p of paths) if (p) addToQueue(p);
}

const dz = document.getElementById("dropZone");
dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("hover");
});
dz.addEventListener("dragleave", () => dz.classList.remove("hover"));

// pywebview exposes a "window.pywebviewdragdrop" event on some backends that
// carries the resolved file paths directly — this is more reliable than
// e.dataTransfer.files which can be empty inside a webview.
window.addEventListener("pywebviewdragdrop", async (e) => {
  if (isRunning) return;
  dz.classList.remove("hover");
  const paths = e.paths || [];
  const videoExts = /\.(mp4|mkv|mov|avi|webm)$/i;
  for (const p of paths) {
    if (videoExts.test(p)) addToQueue(p);
  }
});

dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("hover");
  if (isRunning) return;

  const files = Array.from(e.dataTransfer.files);

  // If the webview gave us zero files (common on GTK/Qt backends), there is
  // nothing we can do here — the pywebviewdragdrop handler above will have
  // already fired with the real paths on those backends.
  if (files.length === 0) return;

  for (const f of files) {
    // f.path is a non-standard property injected by pywebview on some backends.
    // If it's present and looks like an absolute path, use it directly.
    let fullPath = f.path && f.path !== f.name ? f.path : null;

    if (!fullPath) {
      // Fall back: ask Python to search common directories for this filename.
      try {
        fullPath = await pywebview.api.resolve_dropped_path(f.name);
      } catch (_) {
        fullPath = null;
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
  setQueueDragEnabled(!isRunning);
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
  const cancelBtn = document.getElementById("cancelBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  setQueueDragEnabled(!isRunning);
  updateQueueEmpty();
  if (isRunning) {
    btn.disabled = true;
    label.textContent = cancelRequested ? "Cancelling..." : "Compressing...";
    if (cancelBtn) {
      cancelBtn.classList.add("visible");
      cancelBtn.disabled = !!cancelRequested;
      cancelBtn.textContent = cancelRequested
        ? "Cancelling..."
        : "Cancel Session";
    }
    if (resumeBtn) {
      resumeBtn.classList.remove("visible");
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resume Waiting Files";
    }
    return;
  }

  if (cancelBtn) {
    cancelBtn.classList.remove("visible");
    cancelBtn.disabled = false;
    cancelBtn.textContent = "Cancel Session";
  }

  if (resumeBtn) {
    const cancelled = queue.filter((i) => i.status === "cancelled").length;
    const showResume = sessionPaused && cancelled > 0;
    console.log(
      "[updateCompressBtn] sessionPaused=",
      sessionPaused,
      "cancelled=",
      cancelled,
      "showResume=",
      showResume,
    );
    resumeBtn.classList.toggle("visible", showResume);
    resumeBtn.disabled = !showResume;
    resumeBtn.textContent =
      cancelled === 1
        ? "Restart 1 Cancelled File"
        : `Restart ${cancelled} Cancelled Files`;
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
  el.draggable = !isRunning;
  el.innerHTML = `
    <div class="qi-main">
      <button class="qi-drag-handle" title="Drag to reorder" aria-label="Drag to reorder" onmousedown="armQueueDrag('${id}', event)">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <circle cx="2" cy="2" r="1" fill="currentColor"/>
          <circle cx="9" cy="2" r="1" fill="currentColor"/>
          <circle cx="2" cy="5.5" r="1" fill="currentColor"/>
          <circle cx="9" cy="5.5" r="1" fill="currentColor"/>
          <circle cx="2" cy="9" r="1" fill="currentColor"/>
          <circle cx="9" cy="9" r="1" fill="currentColor"/>
        </svg>
      </button>
      <button class="qi-thumb-hit" onclick="previewQueueItem('${id}')" title="Preview video">
        <div class="qi-thumb"><div class="thumb-spinner"></div></div>
        <span class="qi-thumb-play" aria-hidden="true">▶</span>
      </button>
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

  el.addEventListener("dragstart", (e) => {
    if (isRunning || dragHandleArmedId !== id) {
      e.preventDefault();
      return;
    }
    dragSourceId = id;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    wrap.querySelectorAll(".qi.drag-target").forEach((n) => {
      n.classList.remove(
        "drag-target",
        "drag-target-before",
        "drag-target-after",
      );
    });
    dragSourceId = null;
    dragHandleArmedId = null;
    syncQueueOrderFromDom();
  });

  wrap.insertBefore(el, empty);
  empty.style.display = "none";
}

function armQueueDrag(id, e) {
  if (isRunning) return;
  dragHandleArmedId = id;
  if (e) e.stopPropagation();
}

function setQueueDragEnabled(enabled) {
  const wrap = document.getElementById("queueWrap");
  if (!wrap) return;
  wrap.classList.toggle("queue-locked", !enabled);
  wrap.querySelectorAll(".qi").forEach((item) => {
    item.draggable = enabled;
  });
}

function setQueueView(mode) {
  const wrap = document.getElementById("queueWrap");
  if (!wrap || (mode !== "list" && mode !== "grid")) return;
  queueViewMode = mode;
  wrap.classList.toggle("queue-grid", mode === "grid");

  const listBtn = document.getElementById("queueViewListBtn");
  const gridBtn = document.getElementById("queueViewGridBtn");
  if (listBtn) listBtn.classList.toggle("active", mode === "list");
  if (gridBtn) gridBtn.classList.toggle("active", mode === "grid");
}

function syncQueueOrderFromDom() {
  const wrap = document.getElementById("queueWrap");
  if (!wrap || queue.length <= 1) return;
  const ids = Array.from(wrap.querySelectorAll(".qi")).map((node) => node.id);
  if (!ids.length) return;
  const orderIndex = new Map(ids.map((id, idx) => [id, idx]));
  queue.sort((a, b) => {
    const ai = orderIndex.get(a.id);
    const bi = orderIndex.get(b.id);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

function getHoveredQueueItem(x, y, wrap) {
  const hovered = document.elementFromPoint(x, y)?.closest(".qi");
  if (hovered && hovered.parentElement === wrap && hovered.id !== dragSourceId)
    return hovered;
  return null;
}

function clearDragTargets(wrap) {
  wrap.querySelectorAll(".qi.drag-target").forEach((n) => {
    n.classList.remove(
      "drag-target",
      "drag-target-before",
      "drag-target-after",
    );
  });
}

document.addEventListener("mouseup", () => {
  dragHandleArmedId = null;
});

const queueWrap = document.getElementById("queueWrap");
queueWrap.addEventListener("dragover", (e) => {
  if (isRunning || !dragSourceId) return;
  e.preventDefault();

  const hovered = getHoveredQueueItem(e.clientX, e.clientY, queueWrap);
  clearDragTargets(queueWrap);
  if (!hovered) return;

  const rect = hovered.getBoundingClientRect();
  let placeBefore = e.clientY < rect.top + rect.height / 2;

  if (queueViewMode === "grid") {
    const nearRowMid =
      Math.abs(e.clientY - (rect.top + rect.height / 2)) < rect.height * 0.25;
    placeBefore = nearRowMid
      ? e.clientX < rect.left + rect.width / 2
      : e.clientY < rect.top + rect.height / 2;
  }

  hovered.classList.add(
    "drag-target",
    placeBefore ? "drag-target-before" : "drag-target-after",
  );
  queueWrap.insertBefore(
    document.getElementById(dragSourceId),
    placeBefore ? hovered : hovered.nextSibling,
  );
});

queueWrap.addEventListener("drop", (e) => {
  if (isRunning || !dragSourceId) return;
  e.preventDefault();
  clearDragTargets(queueWrap);
  syncQueueOrderFromDom();
});

setQueueView("list");
