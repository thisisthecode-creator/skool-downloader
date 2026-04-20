// Universal Video Downloader - content script
// - On Skool: extracts playbackId/token from __NEXT_DATA__ (fast path)
// - On any other site with a <video>: sends page URL to backend, yt-dlp extracts

const DEFAULT_BACKEND = "https://skool.amacon.dev";

function getBackend() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ backend: DEFAULT_BACKEND }, d => resolve(d.backend));
  });
}

const isSkool = () => location.hostname.endsWith("skool.com");

// ---- Video discovery (Skool fast-path) ------------------------------

function findVideos(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach(v => findVideos(v, out)); return out; }
  if (obj.playbackId && obj.playbackToken) out.push({ playbackId: obj.playbackId, playbackToken: obj.playbackToken });
  Object.values(obj).forEach(v => findVideos(v, out));
  return out;
}

function getSkoolTokens() {
  const out = [];
  const nd = document.getElementById("__NEXT_DATA__");
  if (nd) {
    try { findVideos(JSON.parse(nd.textContent), out); } catch {}
  }
  const text = Array.from(document.querySelectorAll("script")).map(s => s.textContent).join("\n");
  const re = /"playbackId"\s*:\s*"([^"]+)"[^}]*?"playbackToken"\s*:\s*"([^"]+)"/g;
  let m; while ((m = re.exec(text))) out.push({ playbackId: m[1], playbackToken: m[2] });
  const seen = new Set();
  return out.filter(v => seen.has(v.playbackId) ? false : (seen.add(v.playbackId), true));
}

function getPageTitle() {
  return (document.querySelector("h1")?.textContent || document.title || "video").trim();
}

// ---- Job flow --------------------------------------------------------

async function startJob(btn, original) {
  btn.dataset.busy = "1";
  btn.textContent = "Starting...";
  const backend = await getBackend();

  try {
    let startResp;
    if (isSkool()) {
      const tokens = getSkoolTokens();
      if (!tokens.length) throw new Error("No video on page");
      const v = tokens[0];
      startResp = await fetch(backend + "/direct", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playbackId: v.playbackId, playbackToken: v.playbackToken, title: getPageTitle() }),
      });
    } else {
      // Generic path - yt-dlp handles YouTube, Vimeo, Wistia, Brightcove, etc
      startResp = await fetch(backend + "/url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.href, title: getPageTitle() }),
      });
    }
    const j = await startResp.json();
    if (!startResp.ok || !j.job_id) throw new Error(j.error || "Start failed");
    pollJob(j.job_id, btn, backend, original);
  } catch (e) {
    btn.textContent = "✗ " + e.message;
    setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
  }
}

async function pollJob(jobId, btn, backend, original) {
  if (!jobId) return;
  try {
    const r = await fetch(backend + "/status/" + jobId);
    if (!r.ok) throw new Error("job lost");
    const j = await r.json();

    if (j.status === "done" && j.files?.length) {
      const f = j.files[0];
      const fileUrl = backend + "/file/" + f.path;
      btn.textContent = "⏳ transferring...";
      try {
        const fr = await fetch(fileUrl);
        if (!fr.ok) throw new Error("HTTP " + fr.status);
        const blob = await fr.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl; a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        fetch(backend + "/delete/" + f.path, { method: "DELETE" }).catch(() => {});
        btn.textContent = "✓ Downloaded";
        showInfoPanel({ filename: f.name, url: fileUrl });
      } catch (e) {
        btn.textContent = "✗ " + e.message;
      }
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
      return;
    }
    if (j.status === "error") {
      btn.textContent = "✗ " + (j.error || "error");
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
      return;
    }
    btn.textContent = (j.status === "downloading" && typeof j.progress === "number")
      ? `⏳ ${j.progress.toFixed(1)}%`
      : "⏳ " + j.status;
    setTimeout(() => pollJob(jobId, btn, backend, original), 2500);
  } catch (e) {
    btn.textContent = "✗ " + (e.message || "net");
    setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
  }
}

// ---- Button injection ------------------------------------------------

function findPlayerContainer(videoEl) {
  let el = videoEl.parentElement;
  while (el && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 100) return el;
    el = el.parentElement;
  }
  return videoEl.parentElement;
}

function makeButton(label = "⬇ Download") {
  const b = document.createElement("button");
  b.className = "skool-dl-btn";
  b.textContent = label;
  b.title = "Download this video";
  b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.busy) return;
    startJob(b, label);
  };
  return b;
}

function shouldInjectHere() {
  // Always inject on Skool (even if <video> isn't rendered yet)
  if (isSkool()) return true;
  // Otherwise only if there's at least one <video> element
  return document.querySelector("video") !== null;
}

function injectButtons() {
  if (!shouldInjectHere()) {
    document.getElementById("skool-dl-floating")?.remove();
    return;
  }

  const videoEls = Array.from(document.querySelectorAll("video"));

  // No video element yet - floating button in corner
  if (videoEls.length === 0) {
    if (!document.getElementById("skool-dl-floating")) {
      const wrap = document.createElement("div");
      wrap.id = "skool-dl-floating";
      wrap.appendChild(makeButton());
      document.body.appendChild(wrap);
    }
    return;
  }

  document.getElementById("skool-dl-floating")?.remove();

  videoEls.forEach((vel) => {
    if (vel.dataset.dlInjected) return;
    const container = findPlayerContainer(vel);
    if (!container) return;
    container.classList.add("skool-dl-host");
    const btn = makeButton();
    btn.classList.add("skool-dl-btn-in-player");
    container.appendChild(btn);
    vel.dataset.dlInjected = "1";
  });
}

// ---- Info panel ------------------------------------------------------

function showInfoPanel({ filename, url }) {
  document.getElementById("skool-dl-info")?.remove();
  const panel = document.createElement("div");
  panel.id = "skool-dl-info";
  panel.innerHTML = `
    <div class="sdl-row"><strong>✓ Saved to Downloads</strong>
      <button class="sdl-close" title="Close">×</button></div>
    <div class="sdl-path">~/Downloads/${filename}</div>
    <div class="sdl-actions"><button class="sdl-copy">Copy URL</button></div>
    <div class="sdl-url" title="Click to copy">${url}</div>
  `;
  document.body.appendChild(panel);
  panel.querySelector(".sdl-close").onclick = () => panel.remove();
  const copy = () => navigator.clipboard.writeText(url).then(() => {
    const u = panel.querySelector(".sdl-url");
    const old = u.textContent; u.textContent = "✓ Copied"; setTimeout(() => u.textContent = old, 1200);
  });
  panel.querySelector(".sdl-copy").onclick = copy;
  panel.querySelector(".sdl-url").onclick = copy;
  setTimeout(() => panel.remove(), 15000);
}

// ---- Run ------------------------------------------------------------

injectButtons();
setInterval(injectButtons, 1500);
