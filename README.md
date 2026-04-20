# Universal Video Downloader

Download videos from **Skool, YouTube, Vimeo, Wistia, Brightcove** and 1000+ other sites (anything yt-dlp supports).

Three parts:
- **`skool_dl.py`** - CLI (Skool-specific, via Playwright + yt-dlp)
- **`skool_web.py`** - Flask backend with REST API
- **`skool-extension/`** - Chrome extension with in-player download button (works on all sites)

## Quick start (Chrome Extension)

1. Clone this repo
2. Chrome → `chrome://extensions` → **Developer mode** ON
3. **Load unpacked** → select `skool-extension/`
4. Open extension popup → set backend URL (e.g. `https://your-server.com`)
5. Visit any video page → button appears top-right on the player on hover
6. Click → download starts, saves to `~/Downloads/`

## Backend install

```bash
python -m venv .venv && source .venv/bin/activate
pip install playwright yt-dlp browser-cookie3 flask
playwright install chromium   # only needed for Skool CLI path

python skool_web.py           # http://localhost:5005
```

Reverse-proxy the port behind HTTPS (Caddy, nginx, Cloudflare Tunnel, etc).

### Optional: auth cookies for private content

Export browser cookies as Netscape `cookies.txt` (Chrome extension: "Get cookies.txt LOCALLY"), place next to `skool_web.py`. yt-dlp uses them for private YouTube / paid Vimeo / Skool etc.

## REST API

| Method | Route | Body | Purpose |
|---|---|---|---|
| POST | `/direct` | `{playbackId, playbackToken, title}` | Skool fast-path (no Playwright) |
| POST | `/url` | `{url, title?}` | Universal - yt-dlp on any URL |
| POST | `/start` | `{url}` | Skool via Playwright (cookies auto) |
| GET | `/status/<job_id>` | | `{status, progress, files, error}` |
| GET | `/file/<name>` | | Download file (attachment) |
| DELETE | `/delete/<name>` | | Remove file from server |

## How it works

**Skool path:** extension reads `playbackId` + `playbackToken` from `__NEXT_DATA__` embedded in the page, sends to `/direct`. Backend runs yt-dlp against `stream.video.skool.com/<id>.m3u8?token=<token>` with required `Referer: https://www.skool.com/` header.

**Universal path:** extension sends the current page URL to `/url`. Backend runs yt-dlp which auto-detects the platform (YouTube, Vimeo, Wistia, Brightcove, etc).

**Transfer:** when done, extension fetches the file as a blob and triggers download via a blob URL — bypasses cross-origin `download` attribute issues. Server file is deleted immediately after. A cron job also auto-purges leftover files older than 1h.

## CLI (Skool only)

```bash
python skool_dl.py "https://www.skool.com/community/about" -o video.mp4
```
