// ════════════════════════════════════════
// PEAK — Video Compressor  |  settings.js
// ════════════════════════════════════════
// Toggle controls, output directory, and format dropdown.

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

// ════════════════════════════════════════
// Persistent Settings
// ════════════════════════════════════════

function saveSettings() {
  const settings = {
    targetSize: document.getElementById("sizeSlider").value,
    audioBitrate: document.getElementById("audioSlider").value,
    gpu: document.getElementById("gpuToggle").checked,
    combineAudio: document.getElementById("combineAudioToggle").checked,
    twoPass: document.getElementById("twoPassToggle").checked,
    outputDirEnabled: document.getElementById("outputDirToggle").checked,
    customOutDir: customOutDir,
    format: currentFormat,
  };
  localStorage.setItem("peakSettings", JSON.stringify(settings));
}

function loadSettings() {
  const saved = localStorage.getItem("peakSettings");
  if (!saved) return;
  try {
    const settings = JSON.parse(saved);
    // Sliders
    document.getElementById("sizeSlider").value = settings.targetSize || 10;
    document.getElementById("audioSlider").value = settings.audioBitrate || 128;
    document.getElementById("sizeSlider").dispatchEvent(new Event("input"));
    document.getElementById("audioSlider").dispatchEvent(new Event("input"));
    // Toggles
    document.getElementById("gpuToggle").checked = !!settings.gpu;
    document.getElementById("combineAudioToggle").checked =
      !!settings.combineAudio;
    document.getElementById("twoPassToggle").checked = !!settings.twoPass;
    document.getElementById("outputDirToggle").checked =
      !!settings.outputDirEnabled;
    // Global vars
    if (settings.customOutDir) {
      customOutDir = settings.customOutDir;
      document.getElementById("dirPathLabel").textContent = customOutDir;
      document.getElementById("dirPathLabel").classList.add("set");
    }
    document
      .getElementById("outputDirPicker")
      .classList.toggle("visible", !!settings.outputDirEnabled);
    document.getElementById("outputDirSubtitle").textContent =
      settings.outputDirEnabled
        ? customOutDir
          ? shortPath(customOutDir)
          : "Select a folder below"
        : "Off — saves next to source file";
    // Format
    currentFormat = settings.format || "mp4";
    const fmtOption = document.querySelector(
      `.fmt-option[data-value="${currentFormat}"]`,
    );
    if (fmtOption) {
      selectFmt(fmtOption);
    }
  } catch (e) {
    console.warn("Failed to load settings:", e);
  }
}

// Auto-save on changes
["sizeSlider", "audioSlider"].forEach((id) => {
  document.getElementById(id).addEventListener("input", saveSettings);
});
["gpuToggle", "combineAudioToggle", "twoPassToggle", "outputDirToggle"].forEach(
  (id) => {
    document.getElementById(id).addEventListener("change", saveSettings);
  },
);

// Save on format/outputDir/format changes
const selectFmtOrig = selectFmt;
selectFmt = function (el) {
  selectFmtOrig.call(this, el);
  saveSettings();
};

const toggleOutputDirOrig = toggleOutputDir;
toggleOutputDir = function () {
  toggleOutputDirOrig.call(this);
  saveSettings();
};

const pickDirectoryOrig = pickDirectory;
pickDirectory = async function () {
  await pickDirectoryOrig.call(this);
  saveSettings();
};
