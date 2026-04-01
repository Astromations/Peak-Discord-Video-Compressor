// ════════════════════════════════════════
// PEAK — Video Compressor  |  helpers.js
// ════════════════════════════════════════
// Utility / formatting functions used across the app.

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

function shortPath(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

function thumbPlaceholder() {
  return `<svg class="qi-thumb-placeholder" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 10L19.5528 7.72361C20.2177 7.39116 21 7.87465 21 8.61803V15.382C21 16.1253 20.2177 16.6088 19.5528 16.2764L15 14M5 18H13C14.1046 18 15 17.1046 15 16V8C15 6.89543 14.1046 6 13 6H5C3.89543 6 3 6.89543 3 8V16C3 17.1046 3.89543 18 5 18Z" stroke="#949ba4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
