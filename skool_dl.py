#!/usr/bin/env python3
"""Skool video downloader - downloads videos from Skool community pages.

Usage:
    python skool_dl.py "https://www.skool.com/community/about"
    python skool_dl.py "https://www.skool.com/community/classroom/lesson" -o lesson.mp4
    python skool_dl.py "https://www.skool.com/community/about" --cookies cookies.txt
"""

import argparse
import json
import re
import subprocess
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Install: pip install playwright && playwright install chromium")
    sys.exit(1)


def get_chrome_cookies():
    """Try to load Skool cookies from Chrome."""
    try:
        import browser_cookie3
        return {c.name: c.value for c in browser_cookie3.chrome(domain_name=".skool.com")}
    except Exception:
        return {}


def load_cookies_txt(path):
    """Load cookies from Netscape cookies.txt."""
    cookies = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    return cookies


def extract_videos(url, cookies=None, timeout=30000):
    """Load Skool page and extract video info from __NEXT_DATA__."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36"
        )
        if cookies:
            ctx.add_cookies([
                {"name": n, "value": v, "domain": ".skool.com", "path": "/"}
                for n, v in cookies.items()
            ])

        page = ctx.new_page()
        page.goto(url, wait_until="networkidle", timeout=timeout)

        # Extract __NEXT_DATA__ JSON
        try:
            nd_text = page.locator("script#__NEXT_DATA__").inner_text()
            data = json.loads(nd_text)
        except Exception:
            browser.close()
            return [], "unknown"

        # Get page title for filename
        title = page.title() or "skool_video"
        browser.close()

    # Find videos in the page props
    videos = []

    def find_videos(obj):
        if isinstance(obj, dict):
            if "playbackId" in obj and "playbackToken" in obj:
                videos.append(obj)
            else:
                for v in obj.values():
                    find_videos(v)
        elif isinstance(obj, list):
            for v in obj:
                find_videos(v)

    find_videos(data)

    # Deduplicate by playbackId
    seen = set()
    unique = []
    for v in videos:
        pid = v["playbackId"]
        if pid not in seen:
            seen.add(pid)
            unique.append(v)

    return unique, title


def download_video(playback_id, playback_token, output_path, progress_cb=None):
    """Download video using yt-dlp. progress_cb(float 0-100) called on updates."""
    m3u8_url = f"https://stream.video.skool.com/{playback_id}.m3u8?token={playback_token}"

    cmd = [
        "yt-dlp",
        "--newline",
        "--progress",
        "--referer", "https://www.skool.com/",
        "--add-header", "Origin: https://www.skool.com",
        "-o", str(output_path),
        m3u8_url,
    ]

    print(f"Downloading to {output_path}...")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    pct_re = re.compile(r"\[download\]\s+(\d+\.\d+)%")
    for line in proc.stdout:
        m = pct_re.search(line)
        if m and progress_cb:
            try: progress_cb(float(m.group(1)))
            except Exception: pass
    proc.wait()
    return proc.returncode == 0


def sanitize_filename(name):
    """Make a string safe for use as a filename."""
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:200] if name else "skool_video"


def main():
    parser = argparse.ArgumentParser(description="Download videos from Skool")
    parser.add_argument("url", help="Skool page URL")
    parser.add_argument("-o", "--output", help="Output filename")
    parser.add_argument("--cookies", help="Path to cookies.txt (Netscape format)")
    parser.add_argument("--timeout", type=int, default=30, help="Page load timeout seconds")
    parser.add_argument("--list", action="store_true", help="List available videos without downloading")
    args = parser.parse_args()

    # Load cookies
    cookies = {}
    if args.cookies:
        cookies = load_cookies_txt(args.cookies)
        print(f"Loaded {len(cookies)} cookies from {args.cookies}")
    else:
        cookies = get_chrome_cookies()
        if cookies:
            print(f"Loaded {len(cookies)} cookies from Chrome")
        else:
            print("No cookies found - trying without auth")

    # Extract video info
    print(f"Loading {args.url}...")
    videos, title = extract_videos(args.url, cookies, timeout=args.timeout * 1000)

    if not videos:
        print("No videos found on this page.")
        sys.exit(1)

    print(f"Found {len(videos)} video(s)")

    if args.list:
        for i, v in enumerate(videos):
            print(f"  [{i}] {v['playbackId']}")
        return

    # Download each video
    for i, v in enumerate(videos):
        if args.output:
            out = args.output
        elif len(videos) == 1:
            out = f"{sanitize_filename(title)}.mp4"
        else:
            out = f"{sanitize_filename(title)}_{i + 1}.mp4"

        ok = download_video(v["playbackId"], v["playbackToken"], out)
        if ok:
            print(f"Saved: {out}")
        else:
            print(f"Failed to download video {i + 1}")
            sys.exit(1)


if __name__ == "__main__":
    main()
