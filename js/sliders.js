// ════════════════════════════════════════
// PEAK — Video Compressor  |  sliders.js
// ════════════════════════════════════════
// Slider initialization and settings reset.

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
  if (typeof setPreviewMode === "function") {
    setPreviewMode("internal");
  }
  if (typeof saveSettings === "function") {
    saveSettings();
  }
}
