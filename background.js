/* ============================================================
 * Popup Eraser - Background Service Worker (MV3)
 *
 * 役割:
 *   - 初期設定のセットアップ
 *   - キーボードショートカットのハンドリング
 *   - サイト別 ON/OFF の状態に応じた action バッジ表示
 * ============================================================ */

const DEFAULT_GLOBAL = {
  protectCookie: true,
  defaultEnabled: true,
};

// インストール時 / 更新時の初期化
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.sync.get(["globalSettings", "siteSettings"]);
  if (!data.globalSettings) {
    await chrome.storage.sync.set({ globalSettings: DEFAULT_GLOBAL });
  }
  if (!data.siteSettings) {
    await chrome.storage.sync.set({ siteSettings: {} });
  }
});

// ホスト名を取り出すヘルパー
function hostnameFromUrl(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// アクティブタブの content script に toggle メッセージを送る
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE" });
  } catch (e) {
    // content script が未注入の場合（chrome://, store, file:// など）はサイレントに無視
    console.debug("[Popup Eraser bg] toggle failed:", e?.message);
  }
}

// キーボードショートカット (Alt+Shift+E)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-eraser") {
    await toggleActiveTab();
  }
});

// 拡張機能アイコンクリック時の挙動はポップアップに任せるため不要

// バッジ表示の更新（サイト無効化中は "OFF"）
async function updateBadgeForTab(tabId, url) {
  const host = hostnameFromUrl(url);
  if (!host) {
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  const { siteSettings = {}, globalSettings = DEFAULT_GLOBAL } =
    await chrome.storage.sync.get(["siteSettings", "globalSettings"]);
  const enabled = siteSettings[host]?.enabled ?? globalSettings.defaultEnabled ?? true;
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#34c759" : "#8e8e93" });
  await chrome.action.setBadgeText({ tabId, text: enabled ? "" : "OFF" });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadgeForTab(tabId, tab.url || "");
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    await updateBadgeForTab(tabId, tab.url || "");
  }
});

// 設定変更時はすべてのタブのバッジを更新
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (!("siteSettings" in changes) && !("globalSettings" in changes)) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id && t.url) await updateBadgeForTab(t.id, t.url);
  }
});
