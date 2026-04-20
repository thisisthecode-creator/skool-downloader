# Skool Video Downloader

Download videos from Skool community pages.

Three parts:

- **`skool_dl.py`** - CLI downloader (Playwright + yt-dlp)
- **`skool_web.py`** - Flask backend with `/direct` endpoint for the extension
- **`skool-extension/`** - Chrome extension that injects a download button into Skool videos

## CLI

```bash
python -m venv .venv && source .venv/bin/activate
pip install playwright yt-dlp browser-cookie3 flask
playwright install chromium

python skool_dl.py "https://www.skool.com/community/about" -o video.mp4
```

Cookies are pulled from Chrome automatically. For a server install, export cookies as `cookies.txt` (Netscape format) and place next to `skool_web.py`.

## Web backend

```bash
python skool_web.py    # http://localhost:5005
```

Endpoints:
- `POST /direct` - `{playbackId, playbackToken, title}` → `{job_id}` (no Playwright needed)
- `GET  /status/<job_id>` - job status incl. `progress` (0-100)
- `GET  /file/<name>` - download file (Content-Disposition: attachment)
- `DELETE /delete/<name>` - remove file after client downloaded it

## Chrome Extension

1. Chrome → `chrome://extensions` → Developer mode ON
2. Load unpacked → select `skool-extension/`
3. Open the popup, set backend URL (default `https://skool.amacon.dev`)
4. Visit a Skool video page → button appears top-right in the player on hover
5. Click → server downloads via HLS → extension fetches blob → saved to `~/Downloads/`

## How it works

- Skool pages embed `playbackId` + `playbackToken` in `__NEXT_DATA__` or inline scripts
- Video stream is HLS at `https://stream.video.skool.com/<playbackId>.m3u8?token=<playbackToken>`
- `Referer: https://www.skool.com/` required or CDN returns 403
- Backend runs `yt-dlp` with those headers, parses stdout for progress
- Extension fetches the finished file in content-script context and triggers a blob-URL download (bypasses cross-origin `download` attribute issue)
