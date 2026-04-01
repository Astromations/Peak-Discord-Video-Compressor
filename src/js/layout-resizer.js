// ════════════════════════════════════════
// PEAK — Video Compressor  |  layout-resizer.js
// ════════════════════════════════════════
// Draggable divider between tray and settings panels.

(function () {
  const appBody = document.querySelector(".app-body");
  const panelLeft = document.querySelector(".panel-left");
  const panelRight = document.querySelector(".panel-right");
  const divider = document.getElementById("panelDivider");
  const storageKey = "peakPanelSplit";

  if (!appBody || !panelLeft || !panelRight || !divider) return;

  let dragging = false;
  const minLeft = 230;
  const minRight = 360;
  const dividerWidth = 10;

  function isWideLayout() {
    return window.matchMedia("(min-width: 700px)").matches;
  }

  function applySplit(leftPx, rightPx, persist = true) {
    if (!isWideLayout()) return;
    appBody.classList.add("resized");
    appBody.style.setProperty("--left-panel-width", `${Math.round(leftPx)}px`);
    appBody.style.setProperty(
      "--right-panel-width",
      `${Math.round(rightPx)}px`,
    );

    if (persist) {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          left: Math.round(leftPx),
          right: Math.round(rightPx),
        }),
      );
    }
  }

  function clearSplit() {
    appBody.classList.remove("resized");
    appBody.style.removeProperty("--left-panel-width");
    appBody.style.removeProperty("--right-panel-width");
    localStorage.removeItem(storageKey);
  }

  function clampSplit(clientX) {
    const rect = appBody.getBoundingClientRect();
    const total = rect.width;
    let left = clientX - rect.left - dividerWidth / 2;
    left = Math.max(minLeft, left);
    left = Math.min(total - minRight - dividerWidth, left);
    const right = total - dividerWidth - left;
    return { left, right };
  }

  function onMove(e) {
    if (!dragging) return;
    const { left, right } = clampSplit(e.clientX);
    applySplit(left, right);
  }

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.classList.remove("is-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stopDrag);
  }

  divider.addEventListener("mousedown", (e) => {
    if (!isWideLayout()) return;
    e.preventDefault();
    dragging = true;
    divider.classList.add("dragging");
    document.body.classList.add("is-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stopDrag);
  });

  divider.addEventListener("dblclick", () => {
    clearSplit();
  });

  function restoreSplit() {
    if (!isWideLayout()) {
      appBody.classList.remove("resized");
      return;
    }

    const raw = localStorage.getItem(storageKey);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw);
      const rect = appBody.getBoundingClientRect();
      const maxLeft = rect.width - minRight - dividerWidth;
      const left = Math.max(minLeft, Math.min(maxLeft, saved.left || minLeft));
      const right = rect.width - dividerWidth - left;
      if (right >= minRight) applySplit(left, right, false);
    } catch (_) {
      localStorage.removeItem(storageKey);
    }
  }

  window.addEventListener("resize", restoreSplit);
  window.addEventListener("load", restoreSplit, { once: true });
})();
