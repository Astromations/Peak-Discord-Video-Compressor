// ════════════════════════════════════════
// PEAK — Video Compressor  |  changelog-modal.js
// ════════════════════════════════════════
// Changelog modal: build, open, close.

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
