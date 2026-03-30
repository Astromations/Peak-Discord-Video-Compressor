// ════════════════════════════════════════
// PEAK — Video Compressor  |  trim.js
// ════════════════════════════════════════
// Trim modal: video preview, timeline, audio tracks, apply/close.

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
    ? `<svg width="30" height="36" viewBox="0 0 30 36" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M0 35.2334H10V0H0V35.2334ZM20 0V35.2334H30V0H20Z" fill="white" fill-opacity="0.6"/>
</svg>
`
    : `
<svg width="38" height="43" viewBox="0 0 38 43" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M7.5351 0.697925C4.20193 -1.26277 0 1.14049 0 5.00759V37.5235C0 41.3905 4.20193 43.7938 7.5351 41.8331L35.1737 25.5751C38.46 23.6419 38.46 18.8891 35.1737 16.9558L7.5351 0.697925Z" fill="white" fill-opacity="0.6"/>
</svg>
`;
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
