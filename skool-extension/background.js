// Service worker - handles downloads via chrome.downloads API
// Saves files to the user's default Downloads folder with correct filename.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "download") {
    // Fetch in extension context (like curl - no browser download quirks),
    // then save the resulting blob via chrome.downloads.
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: "omit" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        chrome.downloads.download(
          { url: blobUrl, filename: msg.filename, saveAs: false },
          (id) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              downloadSourceUrl.set(id, msg.url);
              sendResponse({ ok: true, id });
              setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
            }
          }
        );
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === "reveal" && msg.id) {
    chrome.downloads.show(msg.id);
    sendResponse({ ok: true });
    return false;
  }
});

// Track source URL per download so we can delete server copy on completion
const downloadSourceUrl = new Map(); // downloadId -> server URL

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete") {
    const serverUrl = downloadSourceUrl.get(delta.id);
    if (serverUrl) {
      // Derive /delete/<name> from /file/<name>
      const delUrl = serverUrl.replace("/file/", "/delete/");
      fetch(delUrl, { method: "DELETE", credentials: "omit" }).catch(() => {});
      downloadSourceUrl.delete(delta.id);
    }
    chrome.downloads.search({ id: delta.id }, (results) => {
      const r = results?.[0];
      if (!r) return;
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => {
          if (t.url?.includes("skool.com")) {
            chrome.tabs.sendMessage(t.id, {
              type: "downloadComplete",
              id: delta.id,
              filename: r.filename,
              url: r.url,
            }).catch(() => {});
          }
        });
      });
    });
  }
});
