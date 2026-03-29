// ════════════════════════════════════════
// PEAK — Video Compressor  |  compressor.js
// ════════════════════════════════════════
// Queue runner, item state renderers, rename dialogs.

// ── Queue runner ──────────────────────────────────────────────────
function startQueue() {
  if (isRunning || !queue.some((i) => i.status === "waiting")) return;
  cancelRequested = false;
  sessionPaused = false;
  isRunning = true;
  document.getElementById("progressTrack").classList.add("visible");
  updateCompressBtn();
  processNext();
}

function cancelQueue() {
  if (!isRunning || cancelRequested) return;
  console.log("[cancelQueue] Cancel requested, calling API...");
  cancelRequested = true;
  setStatus("Cancelling current compression...", "working");
  updateCompressBtn();
  try {
    pywebview.api.cancel_compression();
    console.log(
      "[cancelQueue] API call succeeded, waiting for backend callback...",
    );
  } catch (err) {
    console.log("[cancelQueue] API call failed:", err);
    finishCancelledSession();
  }
}

function finishCancelledSession() {
  isRunning = false;
  cancelRequested = false;
  // Set sessionPaused to true whenever we cancel (regardless of waiting items)
  // This allows restart button to show for cancelled items
  sessionPaused = true;
  const waiting = queue.filter((i) => i.status === "waiting").length;
  const cancelled = queue.filter((i) => i.status === "cancelled").length;
  console.log(
    "[finishCancelledSession] Setting sessionPaused=true, waiting=",
    waiting,
    "cancelled=",
    cancelled,
  );
  document.getElementById("progressTrack").classList.remove("visible");
  setStatus("Compression session cancelled", "error");
  updateCompressBtn();
}

function restartCancelledCompression() {
  if (isRunning || cancelRequested) return;
  const cancelled = queue.filter((i) => i.status === "cancelled");
  if (cancelled.length === 0) return;

  // Mark all cancelled files as waiting again
  cancelled.forEach((item) => {
    item.status = "waiting";
    const sr = document.getElementById(`${item.id}-status`);
    if (sr) {
      sr.innerHTML = `<span class="chip chip-waiting">Waiting</span>`;
    }
  });

  setStatus(
    cancelled.length === 1
      ? "Restarting 1 cancelled file"
      : `Restarting ${cancelled.length} cancelled files`,
    "working",
  );
  updateCompressBtn();
  startQueue();
}

function processNext() {
  if (cancelRequested) {
    finishCancelledSession();
    return;
  }

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
  if (cancelRequested) {
    finishCancelledSession();
    return;
  }
  processNext();
}

function onItemCancelled(id, msg) {
  console.log("[onItemCancelled] Callback received for item", id, "msg=", msg);
  const item = queue.find((i) => i.id === id);
  if (item) {
    item.status = "cancelled";
    console.log("[onItemCancelled] Marked item as cancelled");
  }
  const main = document.querySelector(`#${id} .qi-main`);
  if (main) main.style.removeProperty("--row-progress");
  const sr = document.getElementById(`${id}-status`);
  if (sr)
    sr.innerHTML = `<span class="chip chip-cancelled">Cancelled</span><span style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px" title="${esc(msg || "Compression cancelled")}">${esc(msg || "Compression cancelled")}</span>`;
  document
    .querySelectorAll(`#${id} .qi-btn`)
    .forEach((b) => (b.disabled = false));
  finishCancelledSession();
}

function openOutputFile(id) {
  const path = outputPaths[id];
  if (path) pywebview.api.open_file(path);
}

function revealSourceFile(path) {
  if (path) pywebview.api.open_file(path);
}

// ── Rename dialogs ────────────────────────────────────────────────
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
