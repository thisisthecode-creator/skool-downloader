// Skool Video Downloader - content script
// Finds videos (via __NEXT_DATA__ or page scan), overlays a download button on the video player.

const DEFAULT_BACKEND = "https://skool.amacon.dev";

function getBackend() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ backend: DEFAULT_BACKEND }, d => resolve(d.backend));
  });
}

// ---- Video discovery -------------------------------------------------

function extractFromNextData() {
  const s = document.getElementById("__NEXT_DATA__");
  if (!s) return [];
  try {
    const data = JSON.parse(s.textContent);
    return findVideos(data);
  } catch { return []; }
}

function findVideos(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach(v => findVideos(v, out)); return out; }
  if (obj.playbackId && obj.playbackToken) out.push({ playbackId: obj.playbackId, playbackToken: obj.playbackToken });
  Object.values(obj).forEach(v => findVideos(v, out));
  return out;
}

// Fallback: scrape tokens from the whole DOM (covers SPA-loaded lessons where __NEXT_DATA__ is stale)
function extractFromDom() {
  const out = [];
  // Look in all script tags for playbackId/playbackToken pairs
  const text = Array.from(document.querySelectorAll("script")).map(s => s.textContent).join("\n");
  const re = /"playbackId"\s*:\s*"([^"]+)"[^}]*?"playbackToken"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ playbackId: m[1], playbackToken: m[2] });

  // Also try reverse order
  const re2 = /"playbackToken"\s*:\s*"([^"]+)"[^}]*?"playbackId"\s*:\s*"([^"]+)"/g;
  while ((m = re2.exec(text))) out.push({ playbackId: m[2], playbackToken: m[1] });
  return out;
}

function getAllVideos() {
  const all = [...extractFromNextData(), ...extractFromDom()];
  const seen = new Set();
  return all.filter(v => {
    if (seen.has(v.playbackId)) return false;
    seen.add(v.playbackId);
    return true;
  });
}

function getPageTitle() {
  const h1 = document.querySelector("h1");
  return (h1?.textContent || document.title || "skool_video").trim();
}

// ---- Backend calls ---------------------------------------------------

async function startDownload(video, btn, label) {
  const original = label;
  btn.dataset.busy = "1";
  btn.textContent = "Starting...";
  const backend = await getBackend();
  try {
    const r = await fetch(backend + "/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playbackId: video.playbackId,
        playbackToken: video.playbackToken,
        title: getPageTitle(),
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.job_id) throw new Error(j.error || "Start failed");
    pollJob(j.job_id, btn, backend, original);
  } catch (e) {
    btn.textContent = "✗ " + e.message;
    setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
  }
}

async function pollJob(jobId, btn, backend, original) {
  if (!jobId) {
    btn.textContent = "✗ bad job";
    setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 3000);
    return;
  }
  try {
    const r = await fetch(backend + "/status/" + jobId);
    if (!r.ok) {
      btn.textContent = "✗ job lost";
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 3000);
      return;
    }
    const j = await r.json();
    if (j.status === "done" && j.files?.length) {
      const f = j.files[0];
      // Fetch file in content script context (extension host_permissions allow this),
      // then trigger download via blob URL (always works, cross-origin bypass).
      const fileUrl = backend + "/file/" + f.path;
      btn.textContent = "⏳ transferring...";
      try {
        const fr = await fetch(fileUrl);
        if (!fr.ok) throw new Error("HTTP " + fr.status);
        const blob = await fr.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        // Tell server to delete the file
        fetch(backend + "/delete/" + f.path, { method: "DELETE" }).catch(() => {});
        btn.textContent = "✓ Downloaded";
        // Show info panel
        showInfoPanel({ filename: f.name, url: fileUrl });
      } catch (e) {
        btn.textContent = "✗ " + e.message;
      }
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
      btn.textContent = "✓ Downloaded";
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
      return;
    }
    if (j.status === "error") {
      btn.textContent = "✗ " + (j.error || "error");
      setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
      return;
    }
    if (j.status === "downloading" && typeof j.progress === "number") {
      btn.textContent = `⏳ ${j.progress.toFixed(1)}%`;
    } else {
      btn.textContent = "⏳ " + j.status;
    }
    setTimeout(() => pollJob(jobId, btn, backend, original), 2500);
  } catch {
    btn.textContent = "✗ net";
    setTimeout(() => { btn.textContent = original; delete btn.dataset.busy; }, 4000);
  }
}

// ---- Button injection ------------------------------------------------

function findPlayerContainer(videoEl) {
  // Walk up to find a reasonably-sized ancestor that looks like the player wrapper.
  let el = videoEl.parentElement;
  while (el && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 100) return el;
    el = el.parentElement;
  }
  return videoEl.parentElement;
}

function makeButton(video, label = "⬇ Download") {
  const b = document.createElement("button");
  b.className = "skool-dl-btn";
  b.textContent = label;
  b.title = "Download this video";
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.busy) return;
    startDownload(video, b, label);
  };
  return b;
}

function injectButtons() {
  const videos = getAllVideos();
  if (!videos.length) {
    // Clean up floating button if videos disappeared
    document.getElementById("skool-dl-floating")?.remove();
    return;
  }

  const videoEls = Array.from(document.querySelectorAll("video"));

  if (videoEls.length === 0) {
    // No rendered player yet - show floating fallback so user can still download
    if (!document.getElementById("skool-dl-floating")) {
      const wrap = document.createElement("div");
      wrap.id = "skool-dl-floating";
      videos.forEach((v, i) => {
        const label = videos.length > 1 ? `⬇ Video ${i + 1}` : "⬇ Download";
        wrap.appendChild(makeButton(v, label));
      });
      document.body.appendChild(wrap);
    }
    return;
  }

  // If we have a rendered player, remove the floating fallback
  document.getElementById("skool-dl-floating")?.remove();

  videoEls.forEach((vel, i) => {
    if (vel.dataset.skoolDlInjected) return;
    const video = videos[i] || videos[0];
    if (!video) return;

    const container = findPlayerContainer(vel);
    if (!container) return;

    container.classList.add("skool-dl-host");
    const btn = makeButton(video);
    btn.classList.add("skool-dl-btn-in-player");
    container.appendChild(btn);
    vel.dataset.skoolDlInjected = "1";
  });
}

// ---- Run & observe SPA -----------------------------------------------

injectButtons();
setInterval(injectButtons, 1500);

// ---- Download-complete info panel -----------------------------------

function showInfoPanel({ filename, url }) {
  document.getElementById("skool-dl-info")?.remove();
  const panel = document.createElement("div");
  panel.id = "skool-dl-info";
  panel.innerHTML = `
    <div class="sdl-row"><strong>✓ Saved to Downloads</strong>
      <button class="sdl-close" title="Close">×</button></div>
    <div class="sdl-path">~/Downloads/${filename}</div>
    <div class="sdl-actions">
      <button class="sdl-copy">Copy URL</button>
    </div>
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

