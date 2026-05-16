/* ============================================================
 * Popup Eraser - Popup UI
 * ============================================================ */

const DEFAULT_GLOBAL = {
  protectCookie: true,
  defaultEnabled: true,
};

const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentHost = "";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function isInjectablePage(url) {
  if (!url) return false;
  return /^https?:|^file:/.test(url);
}

async function getSettings() {
  const data = await chrome.storage.sync.get(["globalSettings", "siteSettings"]);
  return {
    global: { ...DEFAULT_GLOBAL, ...(data.globalSettings || {}) },
    siteSettings: data.siteSettings || {},
  };
}

async function setSettings(patch) {
  const cur = await getSettings();
  const next = {
    globalSettings: { ...cur.global, ...(patch.globalSettings || {}) },
    siteSettings: { ...cur.siteSettings, ...(patch.siteSettings || {}) },
  };
  await chrome.storage.sync.set(next);
  // 全タブに通知
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id && isInjectablePage(t.url || "")) {
      chrome.tabs.sendMessage(t.id, { type: "SETTINGS_UPDATED" }).catch(() => {});
    }
  }
}

async function refreshUI() {
  currentTab = await getActiveTab();
  currentHost = hostFromUrl(currentTab?.url || "");
  const injectable = isInjectablePage(currentTab?.url || "");

  $("pe-host").textContent = currentHost || "(このページでは利用不可)";
  $("pe-site-host-small").textContent = currentHost || "—";

  const { global, siteSettings } = await getSettings();
  const siteEnabled = siteSettings[currentHost]?.enabled ?? global.defaultEnabled;

  $("pe-site-enabled").checked = !!siteEnabled;
  $("pe-protect-cookie").checked = !!global.protectCookie;
  $("pe-default-enabled").checked = !!global.defaultEnabled;

  // chrome:// 等では機能不可
  $("pe-start").disabled = !injectable || !siteEnabled;
  $("pe-release").disabled = !injectable;
  $("pe-site-enabled").disabled = !currentHost;
}

async function sendToActiveTab(message) {
  if (!currentTab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(currentTab.id, message);
  } catch (e) {
    console.debug("[Popup Eraser popup] sendMessage failed", e?.message);
    return null;
  }
}

// ===== イベントハンドラ =====

$("pe-start").addEventListener("click", async () => {
  await sendToActiveTab({ type: "ACTIVATE" });
  window.close();
});

$("pe-release").addEventListener("click", async () => {
  await sendToActiveTab({ type: "RELEASE_SCROLL" });
  // 軽いフィードバック
  $("pe-release").textContent = "✅ 解除しました";
  setTimeout(() => { $("pe-release").textContent = "🔓 スクロール解除"; }, 1100);
});

$("pe-site-enabled").addEventListener("change", async (e) => {
  if (!currentHost) return;
  const { siteSettings } = await getSettings();
  const next = {
    ...siteSettings,
    [currentHost]: { ...(siteSettings[currentHost] || {}), enabled: e.target.checked },
  };
  await setSettings({ siteSettings: next });
  $("pe-start").disabled = !e.target.checked || !isInjectablePage(currentTab?.url);
});

$("pe-protect-cookie").addEventListener("change", async (e) => {
  await setSettings({ globalSettings: { protectCookie: e.target.checked } });
});

$("pe-default-enabled").addEventListener("change", async (e) => {
  await setSettings({ globalSettings: { defaultEnabled: e.target.checked } });
});

document.addEventListener("DOMContentLoaded", refreshUI);
