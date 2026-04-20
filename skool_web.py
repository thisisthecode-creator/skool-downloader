#!/usr/bin/env python3
"""Web UI for skool_dl.py - paste URL, download video."""

import os
import re
import subprocess
import threading
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template_string, request, send_from_directory

from skool_dl import download_video, extract_videos, get_chrome_cookies, load_cookies_txt, sanitize_filename

app = Flask(__name__)
BASE = Path(__file__).parent
DOWNLOADS = BASE / "downloads"
DOWNLOADS.mkdir(exist_ok=True)
COOKIES_FILE = BASE / "cookies.txt"


def _load_cookies():
    if COOKIES_FILE.exists():
        return load_cookies_txt(str(COOKIES_FILE))
    return get_chrome_cookies()

# job_id -> {"status": "...", "file": "...", "error": "...", "log": [...]}
JOBS = {}


def run_job(job_id, url):
    job = JOBS[job_id]
    try:
        job["status"] = "loading page"
        cookies = _load_cookies()
        videos, title = extract_videos(url, cookies, timeout=90000)
        if not videos:
            job["status"] = "error"
            job["error"] = "No videos found on this page"
            return

        job["status"] = f"downloading ({len(videos)} video(s))"
        files = []
        for i, v in enumerate(videos):
            name = sanitize_filename(title)
            fname = f"{name}.mp4" if len(videos) == 1 else f"{name}_{i+1}.mp4"
            out = DOWNLOADS / f"{job_id}_{fname}"
            ok = download_video(v["playbackId"], v["playbackToken"], str(out),
                                progress_cb=lambda p: job.update({"progress": p}))
            if ok:
                files.append({"name": fname, "path": out.name})
        job["files"] = files
        job["status"] = "done" if files else "error"
        if not files:
            job["error"] = "Download failed"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


INDEX_HTML = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Skool Downloader</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; background: #fafafa; color: #111; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p.sub { color: #666; margin-top: 0; }
  form { display: flex; gap: 0.5rem; margin: 1.5rem 0; }
  input { flex: 1; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; }
  button { padding: 0.75rem 1.25rem; background: #111; color: white; border: 0; border-radius: 6px; cursor: pointer; font-size: 1rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .job { background: white; padding: 1rem; border-radius: 8px; border: 1px solid #eee; margin-bottom: 0.75rem; }
  .status { font-size: 0.9rem; color: #666; }
  .status.error { color: #c00; }
  .status.done { color: #080; }
  a.dl { display: inline-block; margin-top: 0.5rem; padding: 0.4rem 0.8rem; background: #080; color: white; text-decoration: none; border-radius: 4px; font-size: 0.9rem; }
  .url { font-size: 0.8rem; color: #999; word-break: break-all; margin-bottom: 0.25rem; }
</style>
</head>
<body>
  <h1>Skool Video Downloader</h1>
  <p class="sub">URL einfügen - Chrome-Cookies werden automatisch genutzt.</p>
  <form id="f">
    <input id="url" type="url" placeholder="https://www.skool.com/..." required>
    <button type="submit">Laden</button>
  </form>
  <div id="jobs"></div>
<script>
const jobs = {};
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value;
  const r = await fetch('/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url}) });
  const { job_id } = await r.json();
  jobs[job_id] = { url };
  render();
  poll(job_id);
  document.getElementById('url').value = '';
});

async function poll(id) {
  const r = await fetch('/status/' + id);
  const j = await r.json();
  jobs[id] = { ...jobs[id], ...j };
  render();
  if (j.status !== 'done' && j.status !== 'error') setTimeout(() => poll(id), 2000);
}

function render() {
  const el = document.getElementById('jobs');
  el.innerHTML = Object.entries(jobs).reverse().map(([id, j]) => `
    <div class="job">
      <div class="url">${j.url}</div>
      <div class="status ${j.status}">${j.status || 'starting'}${j.error ? ': ' + j.error : ''}</div>
      ${(j.files || []).map(f => `<a class="dl" href="/file/${f.path}" download="${f.name}">⬇ ${f.name}</a>`).join(' ')}
    </div>`).join('');
}
</script>
</body>
</html>"""


@app.route("/")
def index():
    return render_template_string(INDEX_HTML)


@app.route("/start", methods=["POST"])
def start():
    url = request.json.get("url", "").strip()
    if not re.match(r"^https?://", url):
        return jsonify({"error": "invalid url"}), 400
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "starting", "url": url, "files": []}
    threading.Thread(target=run_job, args=(job_id, url), daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/direct", methods=["POST", "OPTIONS"])
def direct():
    """Extension endpoint - client provides playbackId+token, no Playwright needed."""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.json or {}
    pid = data.get("playbackId", "").strip()
    token = data.get("playbackToken", "").strip()
    title = data.get("title", "skool_video").strip()
    if not pid or not token:
        return jsonify({"error": "playbackId + playbackToken required"}), 400

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "starting", "url": title, "files": []}

    def run():
        job = JOBS[job_id]
        try:
            job["status"] = "downloading"
            name = sanitize_filename(title)
            fname = f"{name}.mp4"
            out = DOWNLOADS / f"{job_id}_{fname}"
            ok = download_video(pid, token, str(out),
                                progress_cb=lambda p: job.update({"progress": p}))
            job["files"] = [{"name": fname, "path": out.name}] if ok else []
            job["status"] = "done" if ok else "error"
            if not ok:
                job["error"] = "Download failed"
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/url", methods=["POST", "OPTIONS"])
def url_download():
    """Generic endpoint - pass any video page URL, yt-dlp handles extraction.
    Works for YouTube, Vimeo, Wistia, Brightcove, and 1000+ other sites."""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.json or {}
    url = (data.get("url") or "").strip()
    title_hint = (data.get("title") or "").strip() or "video"
    if not re.match(r"^https?://", url):
        return jsonify({"error": "invalid url"}), 400

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "starting", "url": url, "files": []}

    def run():
        job = JOBS[job_id]
        try:
            job["status"] = "downloading"
            name = sanitize_filename(title_hint)
            out_tmpl = str(DOWNLOADS / f"{job_id}_{name}.%(ext)s")
            cmd = [
                "yt-dlp", "--newline", "--progress",
                "--no-playlist",
                "--merge-output-format", "mp4",
                "-f", "bv*+ba/b",
                "-o", out_tmpl,
                url,
            ]
            # Optional cookies file for authenticated content
            if COOKIES_FILE.exists():
                cmd.extend(["--cookies", str(COOKIES_FILE)])
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            pct_re = re.compile(r"\[download\]\s+(\d+\.\d+)%")
            final_path = None
            dest_re = re.compile(r"\[download\] Destination: (.+)")
            merger_re = re.compile(r"\[Merger\] Merging formats into \"(.+)\"")
            for line in proc.stdout:
                m = pct_re.search(line)
                if m:
                    try: job["progress"] = float(m.group(1))
                    except Exception: pass
                m2 = dest_re.search(line) or merger_re.search(line)
                if m2:
                    final_path = m2.group(1).strip()
            proc.wait()
            if proc.returncode != 0:
                job["status"] = "error"
                job["error"] = f"yt-dlp exited {proc.returncode}"
                return
            # Find the output file (yt-dlp may have picked any extension)
            if final_path and Path(final_path).exists():
                p = Path(final_path)
            else:
                candidates = sorted(DOWNLOADS.glob(f"{job_id}_*"), key=lambda x: x.stat().st_mtime, reverse=True)
                p = candidates[0] if candidates else None
            if not p or not p.exists():
                job["status"] = "error"; job["error"] = "output file not found"; return
            job["files"] = [{"name": p.name.split("_", 1)[-1], "path": p.name}]
            job["status"] = "done"
        except Exception as e:
            job["status"] = "error"; job["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/delete/<path:name>", methods=["POST", "DELETE", "OPTIONS"])
def delete_file(name):
    if request.method == "OPTIONS":
        return ("", 204)
    # Prevent path traversal
    target = (DOWNLOADS / name).resolve()
    if DOWNLOADS.resolve() not in target.parents:
        return jsonify({"error": "bad path"}), 400
    try:
        target.unlink(missing_ok=True)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


@app.route("/file/<path:name>")
def serve(name):
    return send_from_directory(DOWNLOADS, name, as_attachment=True)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5005"))
    print(f"Open http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
