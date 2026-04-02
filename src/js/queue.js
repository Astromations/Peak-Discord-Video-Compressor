// ════════════════════════════════════════
// PEAK — Video Compressor  |  queue.js
// ════════════════════════════════════════
// Queue management, file browsing, and drag-drop.

// ── File browsing / drag-drop ─────────────────────────────────────
let queueViewMode = "list";
let dragSourceId = null;
let dragHandleArmedId = null;

async function browseFiles() {
  if (isRunning) return;
  let paths;
  try {
    paths = await invoke("open_file_dialog");
  } catch (err) {
    setStatus("File dialog error: " + (err.message || err), "error");
    return;
  }
  // Normalise: some backends return null/undefined on cancel instead of []
  if (!Array.isArray(paths)) return;
  for (const p of paths) if (p) addToQueue(p);
}

const dz = document.getElementById("dropZone");
const videoExts = /\.(mp4|mkv|mov|avi|webm)$/i;

function handleDroppedPaths(paths) {
  if (isRunning || !Array.isArray(paths)) return;
  for (const p of paths) {
    if (typeof p === "string" && videoExts.test(p)) addToQueue(p);
  }
}

window.handleNativeDroppedPaths = (paths) => {
  handleDroppedPaths(paths || []);
};

function isExternalFileDrag(dataTransfer) {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

async function handleDroppedDataTransfer(dataTransfer) {
  if (isRunning || !dataTransfer) return;

  const files = Array.from(dataTransfer.files || []);

  // If browser dataTransfer is empty, Tauri drop listeners handle file paths.
  if (files.length === 0) return;

  for (const f of files) {
    let fullPath = f.path && f.path !== f.name ? f.path : null;

    if (!fullPath) {
      try {
        fullPath = await invoke("resolve_dropped_path", { filename: f.name });
      } catch (_) {
        fullPath = null;
      }
    }

    if (fullPath && videoExts.test(fullPath)) addToQueue(fullPath);
  }
}

dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("hover");
});
dz.addEventListener("dragleave", () => dz.classList.remove("hover"));

dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("hover");
  await handleDroppedDataTransfer(e.dataTransfer);
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

  invoke("get_thumbnail", { filepath: path }).then((uri) => {
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
        <span class="qi-thumb-play" aria-hidden="true">
<svg width="38" height="43" viewBox="0 0 38 43" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M7.5351 0.697925C4.20193 -1.26277 0 1.14049 0 5.00759V37.5235C0 41.3905 4.20193 43.7938 7.5351 41.8331L35.1737 25.5751C38.46 23.6419 38.46 18.8891 35.1737 16.9558L7.5351 0.697925Z" fill="white" fill-opacity="0.6"/>
</svg>
</span>
      </button>
      <div class="qi-body">
        <button class="qi-name qi-name-link" title="Reveal in explorer" onclick="revealSourceFile('${esc(path)}')">${esc(name)}</button>
        <div class="qi-status-row" id="${id}-status">
          <span class="chip chip-waiting">Waiting</span>
        </div>
      </div>
      <div class="qi-actions">
        <button class="qi-btn remove" onclick="removeFromQueue('${id}')" title="Remove"><svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M36 0L20 16L4 0L0 4L16 20L0 36L4 40L20 24L36 40L40 36L24 20L40 4L36 0Z" fill="white" fill-opacity="0.6"/>
</svg>
</button>
<button class="qi-btn trim-btn" id="${id}-trimbtn" onclick="openTrimModal('${id}')" title="Trim / preview">✂</button>
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
  if (isRunning) return;

  if (!dragSourceId) {
    if (isExternalFileDrag(e.dataTransfer)) {
      e.preventDefault();
      dz.classList.add("hover");
    }
    return;
  }

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
  if (isRunning) return;

  if (!dragSourceId) {
    if (isExternalFileDrag(e.dataTransfer)) {
      e.preventDefault();
      dz.classList.remove("hover");
      void handleDroppedDataTransfer(e.dataTransfer);
    }
    return;
  }

  e.preventDefault();
  clearDragTargets(queueWrap);
  syncQueueOrderFromDom();
});

queueWrap.addEventListener("dragleave", () => {
  if (!dragSourceId) dz.classList.remove("hover");
});

setQueueView("list");
