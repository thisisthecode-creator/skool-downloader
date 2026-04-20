const DEFAULT = "https://skool.amacon.dev";
const input = document.getElementById("backend");
const msg = document.getElementById("msg");

chrome.storage.sync.get({ backend: DEFAULT }, d => input.value = d.backend);

document.getElementById("save").onclick = () => {
  const v = input.value.trim().replace(/\/$/, "") || DEFAULT;
  chrome.storage.sync.set({ backend: v }, () => {
    msg.textContent = "Saved ✓";
    setTimeout(() => msg.textContent = "", 1500);
  });
};
