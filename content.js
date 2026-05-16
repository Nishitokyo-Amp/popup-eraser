/* ============================================================
 * Popup Eraser - Content Script
 *
 * 動作モード:
 *   - 手動クリック削除モード（ON/OFF切り替え式）
 *   - モードON中: ホバーで赤枠ハイライト、クリックでHTMLごと削除
 *   - 削除後は body/html の overflow:hidden 等のスクロールロックを解除
 *   - ESC または右クリックでモード解除
 *   - Cookie同意バナー保護モード（任意設定）
 * ============================================================ */

(() => {
  "use strict";

  // 二重注入防止
  if (window.__POPUP_ERASER_INJECTED__) return;
  window.__POPUP_ERASER_INJECTED__ = true;

  // ===== 状態 =====
  const state = {
    active: false,
    hoverEl: null,
    deletedCount: 0,
    protectCookie: false,
    siteEnabled: true, // 当該サイトで拡張機能を使えるか
    autoMode: false,   // 自動削除モード (新しいサイトで自動有効と同じ設定)
    // 削除履歴: { node, originalStyle } を保存して Ctrl+Z で復元
    history: [],
  };

  // 自動モード関連
  let autoModeObserver = null;
  let autoModeScanTimer = null;

  const IS_TOP = window === window.top;
  const MAX_HISTORY = 20;
  const UNDONE_MARKER = "data-popup-eraser-undone";

  // ===== Cookie同意バナー判定キーワード =====
  const COOKIE_KEYWORDS = [
    "cookie", "cookies", "クッキー",
    "gdpr", "ccpa",
    "同意", "consent", "agree",
    "プライバシー", "privacy policy",
    "個人情報",
  ];

  // ===== ユーティリティ =====
  const log = (...args) => console.debug("[Popup Eraser]", ...args);

  function getHostKey() {
    try { return location.hostname || "unknown"; } catch { return "unknown"; }
  }

  /**
   * ある要素が Cookie 同意バナーらしいかをヒューリスティックに判定。
   * テキストに「Cookie」「同意」等を含み、かつ「同意ボタン」のようなものを内部に持つ場合に true。
   */
  function looksLikeCookieBanner(el) {
    if (!el) return false;
    const text = (el.innerText || el.textContent || "").toLowerCase().slice(0, 600);
    if (!text) return false;
    const hasCookieKeyword = COOKIE_KEYWORDS.some(k => text.includes(k.toLowerCase()));
    if (!hasCookieKeyword) return false;
    // ボタン/同意リンクの存在
    const hasButton =
      el.querySelector("button, [role='button'], a") !== null;
    return hasButton;
  }

  /**
   * モーダル系のキーワードか判定するヘルパー。
   * CSS Modules で生成される `QuestionnaireModal_gender__zytPc` のような
   * 「Xxx + Modal + _子要素名」パターンを除外するため、
   * "modal"等のキーワードが「単語/コンポーネント名そのもの」として現れるときのみ true。
   */
  function classLooksLikeModal(className) {
    if (!className) return false;
    const cls = String(className).toLowerCase();
    // CSS Modules / BEM 風のトークンに分解
    const tokens = cls.split(/[\s_\-]+/);
    const KEYWORDS = ["modal", "dialog", "popup", "popover", "overlay",
                      "lightbox", "drawer", "sheet", "backdrop"];
    // 完全一致するトークンがあれば true (modal_overlay, dialog__abc, popup-box など)
    for (const t of tokens) {
      // ハッシュ部 (例 zBMug) はスキップ
      if (KEYWORDS.includes(t)) return true;
    }
    // それ以外 (QuestionnaireModal_gender 等) は false 扱い
    return false;
  }

  /**
   * モーダルらしさを示す属性を持っているか
   */
  function isModalLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "DIALOG") return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (el.getAttribute && el.getAttribute("aria-modal") === "true") return true;
    // class/id をトークン分解して厳密にチェック
    const cls = (el.className || "").toString();
    const id = (el.id || "");
    if (classLooksLikeModal(cls)) return true;
    if (classLooksLikeModal(id)) return true;
    return false;
  }

  /**
   * 削除対象として最も適切な「ポップアップ的なコンテナ」を見つける。
   * クリックした要素そのものは内側のボタンや画像であることが多いため、
   * 上位の祖先まで遡って下記いずれかにマッチするものを採用する:
   *   - <dialog> / role="dialog" / aria-modal などのモーダル属性
   *   - position: fixed/sticky/absolute + 高 z-index
   *   - 画面の大部分を覆う fixed/absolute 要素
   *   - クラス名・IDに modal/popup/overlay 等の語を含む要素
   */
  function findPopupContainer(startEl) {
    if (!startEl || startEl === document.body || startEl === document.documentElement) {
      return startEl;
    }
    let node = startEl;
    let candidate = startEl;
    let outermostModal = null; // 一番外側のモーダル様要素を覚える
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 30) {
      const cs = getComputedStyle(node);
      const pos = cs.position;
      const z = parseInt(cs.zIndex, 10);
      const rect = node.getBoundingClientRect();
      const coversLarge =
        rect.width >= window.innerWidth * 0.4 &&
        rect.height >= window.innerHeight * 0.25;

      // 1) モーダル系の属性にマッチ → 記憶して引き続き上位を探す
      //    (CSS Modules で内側コンポーネントが先にヒットしても、最外殻を採用するため)
      if (isModalLike(node)) {
        outermostModal = node;
      }
      // 2) 位置指定 + z-index
      if (
        (pos === "fixed" || pos === "sticky" || pos === "absolute") &&
        (Number.isFinite(z) ? z >= 10 : true)
      ) {
        candidate = node;
      }
      // 3) 大画面占有
      if (coversLarge && (pos === "fixed" || pos === "absolute")) {
        candidate = node;
      }
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      depth++;
    }
    // 最外殻のモーダル様要素を最優先で返す
    return outermostModal || candidate;
  }

  /**
   * 真のクリック対象を取得する（Shadow DOM 貫通）
   */
  function realTarget(e) {
    if (typeof e.composedPath === "function") {
      const path = e.composedPath();
      if (path && path.length) return path[0];
    }
    return e.target;
  }

  /**
   * 要素が UI 上見えているか（簡易チェック）
   */
  function isVisibleForUI(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 30) return false;
    return true;
  }

  /**
   * 祖先 container の中で「最も外側のモーダル様要素」を探す。
   * これは、クリック対象がモーダルの兄弟（コントロールオーバーレイ等）の場合に有効。
   *
   * 例: TVer の video.js
   *   PlayerLayout
   *     ├─ VodController (←クリック)
   *     ├─ vjs-modal-dialog (←本当に削除したい)
   *     └─ video
   */
  function findInnerModalWithin(container, exclude) {
    if (!container || container.nodeType !== 1) return null;
    // 属性ベース (role/aria/tag) を最優先で、クラスベースは isModalLike で厳密判定する
    const sel = [
      "dialog",
      "[role='dialog']",
      "[role='alertdialog']",
      "[aria-modal='true']",
      ".vjs-modal-dialog",
      // CSS Modules や BEM 由来のクラスは attribute selector では誤検出が多いため、
      // candidate を広めに取って後段の classLooksLikeModal で絞り込む
      "[class*='modal']",
      "[class*='Modal']",
      "[class*='dialog']",
      "[class*='Dialog']",
      "[class*='popup']",
      "[class*='Popup']",
      "[class*='overlay']",
      "[class*='Overlay']",
      "[class*='lightbox']",
      "[class*='Lightbox']",
    ].join(",");

    let matches;
    try { matches = container.querySelectorAll(sel); }
    catch { return null; }

    const outers = [];
    for (const m of matches) {
      if (m === container || m === exclude) continue;
      if (exclude && (exclude.contains(m) || m.contains(exclude))) continue;
      // 確実にモーダル様 (=トークンとしてキーワードが出現) なものだけ
      if (!isModalLike(m)) continue;
      // モーダル風だが UI コンテンツ (modal-content / modal-body 等) は内側なのでスキップ
      const cls = (m.className || "").toString().toLowerCase();
      if (/(modal|dialog|popup)[-_]?(content|body|inner|header|footer|title|wrapper|form|field|input|label|button)/.test(cls)) continue;
      // CSS Modules の "XxxModal_<部品名>" は内側パーツ。クラスに "_" を含み、
      // _ の前が大文字始まりの長い名前で、かつ _ の後が短い部品名なら部品とみなす。
      // ※ classLooksLikeModal で除外済みだが念のため
      if (!isVisibleForUI(m)) continue;
      // 「最も外側」かを判定（先祖の中に同条件のモーダル要素がいないか）
      let p = m.parentElement;
      let isOuter = true;
      while (p && p !== container) {
        if (isModalLike(p)) { isOuter = false; break; }
        p = p.parentElement;
      }
      if (isOuter) outers.push(m);
    }
    if (outers.length === 0) return null;
    // 最も大きい（=最も外側のラッパー）を選ぶ
    outers.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return outers[0];
  }

  /**
   * グローバルに「いま画面に出ているモーダル」を一覧する。
   * クリック先からたどれない場合のフォールバック用。
   */
  function findAllVisibleModals() {
    return findInnerModalWithin(document.body) ? [findInnerModalWithin(document.body)] : [];
  }

  /**
   * クリック/ホバー時に「真に削除すべき要素」を確定する高レベル関数。
   *
   *  1) startEl から祖先方向に findPopupContainer で候補を取る
   *  2) その候補の内側に「明確にモーダル様」の兄弟がいないかを探す
   *     (TVer の vjs-modal-dialog がここで救済される)
   *  3) どちらも該当しなければ、ページ全体から最有力のモーダルを探すフォールバック
   */
  function findBestPopupTarget(startEl) {
    const upCandidate = findPopupContainer(startEl);
    // upCandidate 内に隠れているモーダルを優先
    const inner = findInnerModalWithin(upCandidate, startEl);
    if (inner) return inner;
    // upCandidate がモーダル様ならそれを返す
    if (isModalLike(upCandidate)) return upCandidate;
    // 念のためページ全体でも探す
    const global = findInnerModalWithin(document.body, startEl);
    if (global) return global;
    return upCandidate;
  }

  /**
   * 削除対象の要素と、それに紐づくオーバーレイを推定して返す。
   * オーバーレイ = 兄弟または body 直下の position:fixed で
   * 画面いっぱいに広がっている半透明要素。
   */
  function findRelatedOverlays(targetEl) {
    const overlays = [];
    if (!targetEl) return overlays;

    const all = document.querySelectorAll("body *");
    all.forEach(el => {
      if (el === targetEl || targetEl.contains(el) || el.contains(targetEl)) return;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed") return;
      const rect = el.getBoundingClientRect();
      const coversFull =
        rect.width >= window.innerWidth * 0.9 &&
        rect.height >= window.innerHeight * 0.9 &&
        rect.left <= 5 && rect.top <= 5;
      if (!coversFull) return;
      // 半透明 or 暗い背景
      const bg = cs.backgroundColor || "";
      const hasOverlayBg =
        /rgba?\([^)]*\)/.test(bg) ||
        parseFloat(cs.opacity) < 1;
      if (hasOverlayBg) overlays.push(el);
    });
    return overlays;
  }

  /**
   * body, html のスクロールロックを「非破壊的」に解除する。
   *
   * 重要: TVer のように <html class="light"> 等にサイト固有のレイアウト指定がある場合、
   *       こちらが !important で position:static 等を強制すると動画プレイヤーのレイアウトが
   *       壊れる。よってここでは以下のみ行う:
   *   - インラインスタイルで「スクロール抑止」されている値だけを除去
   *   - 一般的な modal-open 系のクラスだけを除去
   *   - サイトの本来の CSS は触らない
   */
  /**
   * モーダル展開時に html/body に付与される「スクロールロック用クラス」を
   * パターンで判定する。サイト固有の命名 (Piano の tp-modal-open など) も
   * 自動でカバーするため、ハードコードした単語リストではなく正規表現を使う。
   */
  const SCROLL_LOCK_PATTERNS = [
    /(^|[\s_-])modal[-_]?open([\s_-]|$)/i,
    /(^|[\s_-])is[-_]?modal[-_]?open([\s_-]|$)/i,
    /(^|[\s_-])has[-_]?modal([\s_-]|$)/i,
    /(^|[\s_-])modal[-_]?active([\s_-]|$)/i,
    /(^|[\s_-])no[-_]?scroll([\s_-]|$)/i,
    /(^|[\s_-])noscroll([\s_-]|$)/i,
    /(^|[\s_-])scroll[-_]?lock([\s_-]|$)/i,
    /(^|[\s_-])lock[-_]?scroll([\s_-]|$)/i,
    /(^|[\s_-])lock[-_]?overflow([\s_-]|$)/i,
    /(^|[\s_-])overflow[-_]?hidden([\s_-]|$)/i,
    /(^|[\s_-])is[-_]?locked([\s_-]|$)/i,
    /(^|[\s_-])is[-_]?fixed([\s_-]|$)/i,
    /(^|[\s_-])fixed[-_]?body([\s_-]|$)/i,
    // ベンダー / 主要ライブラリ
    /^tp[-_]modal[-_]?open$/i,           // Piano (tinypass)
    /^fancybox[-_](active|locked|enabled)/i,
    /^mfp[-_]/i,                          // Magnific Popup
    /^ReactModal__Body--open$/,           // react-modal
    // 包括フォールバック ("foo-open", "foo-locked" 等)
    /[-_](open|locked|disabled)$/i,
  ];
  function isScrollLockClass(cls) {
    if (!cls) return false;
    for (const p of SCROLL_LOCK_PATTERNS) {
      if (p.test(cls)) return true;
    }
    return false;
  }

  /**
   * 読み込み済みCSSをスキャンし、`overflow: hidden` / `position: fixed`
   * を当てている **単一クラスセレクタ** を抽出する。
   * これにより、未知の命名でもページ実装に追従できる。
   * 1回計算したらキャッシュ。
   */
  let _lockingClassCache = null;
  function getLockingClassesFromCSS() {
    if (_lockingClassCache) return _lockingClassCache;
    const set = new Set();
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules || sheet.rules; } catch { continue; } // CORS で読めない
        if (!rules) continue;
        for (const rule of rules) {
          const txt = rule.cssText || "";
          if (!/overflow\s*:\s*hidden|position\s*:\s*fixed/i.test(txt)) continue;
          const sel = rule.selectorText || "";
          // 単純クラスセレクタ (.foo) のみ採用
          let m = sel.match(/^\s*\.([a-zA-Z0-9_-]+)\s*$/);
          if (m) { set.add(m[1]); continue; }
          // body.foo / html.foo も拾う
          m = sel.match(/^\s*(?:html|body)\.([a-zA-Z0-9_-]+)\s*$/);
          if (m) set.add(m[1]);
        }
      }
    } catch {}
    _lockingClassCache = set;
    return set;
  }

  /**
   * 要素を「React安全」に非表示化する。
   *
   * 物理的に `remove()` すると React の reconciliation が
   *   NotFoundError: Failed to execute 'removeChild' ...
   * を投げ、Error Boundary が「このコンテンツは現在表示できません」等の
   * 後発エラーUIを描画してしまうため、ここではノードを DOM ツリーから外さず、
   * !important で display/visibility/pointer-events を抑止して
   * ユーザーから見て完全に「消えた」状態にする。
   *
   * バツボタンの click ハンドラを起動しないので
   * 「閉じても再表示される」現象も発生しない。
   */
  const HIDE_MARKER = "data-popup-eraser-hidden";

  function hideSafely(el) {
    if (!el || el.nodeType !== 1) return null;
    if (!el.isConnected) return null;
    if (el.getAttribute(HIDE_MARKER)) return null; // 既に隠してある

    // Undo 用に元のインラインスタイルを保存
    const snap = (prop) => ({
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    });
    const saved = {
      display: snap("display"),
      visibility: snap("visibility"),
      opacity: snap("opacity"),
      pointerEvents: snap("pointer-events"),
      transform: snap("transform"),
    };

    el.setAttribute(HIDE_MARKER, "1");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");

    return { node: el, originalStyle: saved };
  }

  function restoreSafely(entry) {
    if (!entry || !entry.node) return false;
    const el = entry.node;
    if (!el.isConnected) return false;
    el.removeAttribute(HIDE_MARKER);
    // 一旦、強制した3プロパティを除去
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
    el.style.removeProperty("pointer-events");
    // 元の値があれば戻す
    const s = entry.originalStyle || {};
    const restore = (prop, snap) => {
      if (!snap) return;
      if (snap.value) el.style.setProperty(prop, snap.value, snap.priority || "");
    };
    restore("display", s.display);
    restore("visibility", s.visibility);
    restore("opacity", s.opacity);
    restore("pointer-events", s.pointerEvents);
    restore("transform", s.transform);
    // 復元した要素には「最近Undoした」マーカーを付与し、
    // 自動モードがすぐに再削除してしまうのを防ぐ (60秒間)
    try { el.setAttribute(UNDONE_MARKER, String(Date.now())); } catch {}
    return true;
  }

  function isRecentlyUndone(el) {
    if (!el || !el.getAttribute) return false;
    const ts = el.getAttribute(UNDONE_MARKER);
    if (!ts) return false;
    return (Date.now() - parseInt(ts, 10)) < 60_000;
  }

  function releaseScrollLock() {
    const lockingFromCSS = getLockingClassesFromCSS();
    [document.documentElement, document.body].forEach(el => {
      if (!el) return;
      // 1) スクロール抑止の典型インラインスタイルだけを除去（!important は付けない）
      const props = [
        "overflow", "overflow-x", "overflow-y",
        "position",
        "pointer-events",
        "touch-action",
        "padding-right", "margin-right",
        "height", "width",
      ];
      for (const p of props) {
        if (el.style.getPropertyValue(p)) {
          el.style.removeProperty(p);
        }
      }
      // 2) クラス: ① パターン or ② CSS解析でロック動作と判定された class を外す
      const toRemove = [];
      el.classList.forEach(cls => {
        if (isScrollLockClass(cls) || lockingFromCSS.has(cls)) {
          toRemove.push(cls);
        }
      });
      for (const c of toRemove) {
        el.classList.remove(c);
      }
    });
  }

  // ===== 自動削除モード =====
  //
  // 一番外側の「画面を覆っているラッパー」(=ポップアップ本体) を
  // 表示と同時に検出して非表示化する。手動クリック不要。
  //
  // 候補抽出ルール:
  //   1) <dialog open> / [role="dialog"] / aria-modal="true"
  //   2) クラス/IDにモーダル系トークンを含む大きめ要素 (>=画面の30%)
  //   3) body直下の position:fixed で画面の40%×30%以上を覆う要素
  //
  // どの場合も、確定した候補からさらに親方向へ「最外殻のモーダル様ラッパー」
  // まで遡って、それを削除対象とする。
  //

  function isOurUIElement(el) {
    if (!el) return false;
    if (el.id === "popup-eraser-statusbar") return true;
    return !!(el.closest && el.closest("#popup-eraser-statusbar"));
  }

  function findAutoDeleteCandidates() {
    const seen = new Set();
    const out = [];

    const tryAdd = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (seen.has(el)) return;
      if (el === document.body || el === document.documentElement) return;
      if (el.hasAttribute && el.hasAttribute(HIDE_MARKER)) return; // 既に隠してある
      if (isRecentlyUndone(el)) return;
      if (isOurUIElement(el)) return;
      if (!isVisibleForUI(el)) return;
      seen.add(el);
      out.push(el);
    };

    // 1) 明示的なダイアログ系
    document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .vjs-modal-dialog:not(.vjs-hidden)'
    ).forEach(tryAdd);

    // 2) モーダル系クラスを持つ大きめ要素
    const classSel = "[class*='modal'],[class*='Modal'],[class*='dialog'],[class*='Dialog'],[class*='popup'],[class*='Popup'],[class*='overlay'],[class*='Overlay'],[class*='lightbox'],[class*='Lightbox']";
    document.querySelectorAll(classSel).forEach(el => {
      if (!isModalLike(el)) return; // 厳密判定で誤検出を弾く
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.3) return;
      if (r.height < window.innerHeight * 0.2) return;
      tryAdd(el);
    });

    // 3) body直下の fixed で大きい要素 (キーワードがない単純なオーバーレイ)
    document.querySelectorAll("body > *").forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.4) return;
      if (r.height < window.innerHeight * 0.3) return;
      // 高 z-index またはモーダル様
      const z = parseInt(cs.zIndex, 10);
      if (!(Number.isFinite(z) && z >= 100) && !isModalLike(el)) return;
      tryAdd(el);
    });

    // 各候補について、親に「より外側のモーダル様要素」がいればそちらを採用
    return out.map(el => {
      let outer = el;
      let p = el.parentElement;
      let depth = 0;
      while (p && p !== document.body && p !== document.documentElement && depth < 10) {
        if (isModalLike(p) && isVisibleForUI(p)) outer = p;
        p = p.parentElement;
        depth++;
      }
      return outer;
    });
  }

  function runAutoScan() {
    if (state.active) return;          // 手動クリックモード中は自動削除しない
    if (!state.siteEnabled) return;
    if (!state.autoMode) return;

    const targets = findAutoDeleteCandidates();
    if (!targets.length) return;

    let removedThisRun = 0;
    for (const target of targets) {
      // Cookie保護モード時は同意系バナーをスキップ
      if (state.protectCookie && looksLikeCookieBanner(target)) continue;
      if (target.hasAttribute(HIDE_MARKER)) continue;

      const entry = hideSafely(target);
      if (!entry) continue;

      // 兄弟オーバーレイも同時に隠す
      const overlays = findRelatedOverlays(target);
      const session = [entry];
      overlays.forEach(o => {
        const e = hideSafely(o);
        if (e) session.push(e);
      });
      state.history.push(session);
      if (state.history.length > MAX_HISTORY) state.history.shift();
      state.deletedCount++;
      removedThisRun++;
      log("自動削除:", target);
    }
    if (removedThisRun > 0) {
      releaseScrollLock();
    }
  }

  function scheduleAutoScan(delay) {
    if (autoModeScanTimer) clearTimeout(autoModeScanTimer);
    autoModeScanTimer = setTimeout(() => {
      autoModeScanTimer = null;
      runAutoScan();
    }, typeof delay === "number" ? delay : 250);
  }

  function startAutoMode() {
    if (autoModeObserver) return;
    // 初回スキャン
    scheduleAutoScan(400);
    // DOM変更を監視: 新規追加された要素にモーダル系シグナルがあればスキャン
    autoModeObserver = new MutationObserver(mutations => {
      let likely = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "DIALOG") { likely = true; break; }
          const sig = ((node.className || "") + " " + (node.id || "")).toLowerCase();
          if (/modal|dialog|popup|overlay|lightbox|backdrop/i.test(sig)) { likely = true; break; }
          // body 配下の fixed 要素もチェック
          if (node.parentElement === document.body) {
            try {
              if (getComputedStyle(node).position === "fixed") { likely = true; break; }
            } catch {}
          }
        }
        if (likely) break;
      }
      if (likely) scheduleAutoScan(200);
    });
    try {
      autoModeObserver.observe(document.body, { childList: true, subtree: true });
    } catch {}
    log("自動削除モード ON");
  }

  function stopAutoMode() {
    if (autoModeScanTimer) { clearTimeout(autoModeScanTimer); autoModeScanTimer = null; }
    if (autoModeObserver) {
      try { autoModeObserver.disconnect(); } catch {}
      autoModeObserver = null;
      log("自動削除モード OFF");
    }
  }

  // ===== UI: ステータスバー (top frame のみ表示) =====
  function showStatusBar() {
    if (!IS_TOP) return;
    removeStatusBar();
    const bar = document.createElement("div");
    bar.id = "popup-eraser-statusbar";
    bar.innerHTML = `
      <span>🎯 クリック削除モード</span>
      <span class="pe-key">ESC</span><span>で終了</span>
      <span class="pe-key">⌘Z</span><span>で元に戻す</span>
      <span class="pe-key">右クリック</span><span>でキャンセル</span>
      <span class="pe-count" id="pe-count">0</span>
    `;
    (document.body || document.documentElement).appendChild(bar);
  }
  function removeStatusBar() {
    document.getElementById("popup-eraser-statusbar")?.remove();
  }
  function bumpCounter() {
    const el = document.getElementById("pe-count");
    if (el) el.textContent = String(state.deletedCount);
  }
  // 子フレームから親へ削除通知（カウンタ更新用）
  function notifyParentDeleted() {
    if (IS_TOP) return;
    try {
      window.top.postMessage({ __popup_eraser__: true, type: "FRAME_DELETED" }, "*");
    } catch {}
  }

  // ===== ホバー処理 =====
  function clearHoverHighlight() {
    if (state.hoverEl) {
      state.hoverEl.classList.remove("popup-eraser-hover");
      state.hoverEl.classList.remove("popup-eraser-protected");
      state.hoverEl = null;
    }
  }

  function onMouseOver(e) {
    if (!state.active) return;
    const t0 = realTarget(e);
    const target = findBestPopupTarget(t0);
    if (!target || target === state.hoverEl) return;
    clearHoverHighlight();
    state.hoverEl = target;

    // Cookie 保護
    if (state.protectCookie && looksLikeCookieBanner(target)) {
      target.classList.add("popup-eraser-protected");
    } else {
      target.classList.add("popup-eraser-hover");
    }
  }

  function onMouseOut() {
    if (!state.active) return;
    clearHoverHighlight();
  }

  // ===== クリックで削除 =====
  function onClickCapture(e) {
    if (!state.active) return;
    // ステータスバー上のクリックは無視
    const t0 = realTarget(e);
    if (t0?.closest && t0.closest("#popup-eraser-statusbar")) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = findBestPopupTarget(t0);
    if (!target) return;

    // Cookie 保護中はスキップ
    if (state.protectCookie && looksLikeCookieBanner(target)) {
      flashMessage("🔒 Cookie同意バナーは保護中です");
      return;
    }

    // 関連オーバーレイ
    const overlays = findRelatedOverlays(target);

    // フラッシュアニメ → 削除（display:none で React 安全に「消す」）
    [target, ...overlays].forEach(el => {
      try { el.classList.add("popup-eraser-flash"); } catch {}
    });
    setTimeout(() => {
      const hidden = [];
      const tryHide = (el) => {
        const entry = hideSafely(el);
        if (entry) hidden.push(entry);
      };
      tryHide(target);
      overlays.forEach(tryHide);
      // 履歴に積む（1クリック=1セット）
      if (hidden.length) {
        state.history.push(hidden);
        if (state.history.length > MAX_HISTORY) state.history.shift();
      }
      releaseScrollLock();
      state.deletedCount++;
      bumpCounter();
      notifyParentDeleted();
      log("非表示化しました:", target, "オーバーレイ:", overlays.length);
    }, 180);

    clearHoverHighlight();
    return false;
  }

  // 通常クリック（capture）も飲み込んで、削除モード中はサイト側に伝えない
  function onClickBubble(e) {
    if (!state.active) return;
    const t0 = realTarget(e);
    if (t0?.closest && t0.closest("#popup-eraser-statusbar")) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    if (!state.active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    deactivate();
  }

  function onKeyDown(e) {
    if (!state.active) return;
    // ESC: モード終了 (TVer等の他のESCハンドラに渡さない)
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      deactivate();
      return;
    }
    // Ctrl+Z / Cmd+Z: 直前の削除を元に戻す
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      undoLastDeletion();
      return;
    }
  }

  /**
   * 直前のクリックで隠した要素群を復元する
   */
  function undoLastDeletion() {
    const last = state.history.pop();
    if (!last || !last.length) {
      flashMessage("⏎ 元に戻す対象がありません");
      return;
    }
    let restored = 0;
    // 復元（DOM上の順序は変わっていないので、各エントリのスタイルを戻すだけ）
    for (let i = last.length - 1; i >= 0; i--) {
      try {
        if (restoreSafely(last[i])) restored++;
      } catch (err) { log("復元失敗", err); }
    }
    state.deletedCount = Math.max(0, state.deletedCount - 1);
    bumpCounter();
    flashMessage(`↩︎ ${restored}個の要素を復元`);
    log("Undo:", restored, "個復元");
  }

  function flashMessage(msg) {
    const bar = document.getElementById("popup-eraser-statusbar");
    if (!bar) return;
    const prev = bar.innerHTML;
    bar.innerHTML = `<span>${msg}</span>`;
    setTimeout(() => { bar.innerHTML = prev; bumpCounter(); }, 1100);
  }

  // ===== モードのON/OFF =====
  function activate() {
    if (!state.siteEnabled) return;
    if (state.active) return;
    state.active = true;
    state.deletedCount = 0;
    document.documentElement.classList.add("popup-eraser-active");
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("click", onClickBubble, false);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    showStatusBar();
    broadcastToFrames("ACTIVATE");
    log("クリック削除モード ON", IS_TOP ? "(top)" : "(iframe)");
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    document.documentElement.classList.remove("popup-eraser-active");
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("click", onClickBubble, false);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("keydown", onKeyDown, true);
    clearHoverHighlight();
    removeStatusBar();
    broadcastToFrames("DEACTIVATE");
    log("クリック削除モード OFF");
  }

  /**
   * top → child iframe / child → 兄弟 へポップアップイレーザーの状態を伝達
   * chrome.tabs.sendMessage は概ね全フレームに届くが、念のため postMessage でも補完。
   */
  function broadcastToFrames(type) {
    try {
      for (let i = 0; i < window.frames.length; i++) {
        window.frames[i].postMessage({ __popup_eraser__: true, type }, "*");
      }
    } catch {}
  }

  function toggle() {
    if (!state.siteEnabled) {
      log("このサイトでは拡張機能が無効です");
      return;
    }
    state.active ? deactivate() : activate();
  }

  // ===== 設定の読み込み =====
  async function loadSettings() {
    const host = getHostKey();
    const data = await chrome.storage.sync.get(["siteSettings", "globalSettings"]);
    const global = data.globalSettings || { protectCookie: true, defaultEnabled: true };
    const siteSettings = data.siteSettings || {};
    const site = siteSettings[host];

    state.protectCookie = global.protectCookie ?? true;
    state.siteEnabled = site?.enabled ?? global.defaultEnabled ?? true;
    // 自動削除モードは "新しいサイトで自動有効 (defaultEnabled)" と同一トグルで制御
    state.autoMode = (global.defaultEnabled ?? true) === true;

    // 自動モードの起動/停止を設定に同期
    if (state.siteEnabled && state.autoMode) {
      startAutoMode();
    } else {
      stopAutoMode();
    }
  }

  // ===== メッセージング =====
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case "PING":
          sendResponse({ ok: true, active: state.active, siteEnabled: state.siteEnabled });
          break;
        case "TOGGLE":
          await loadSettings();
          toggle();
          sendResponse({ ok: true, active: state.active });
          break;
        case "ACTIVATE":
          await loadSettings();
          activate();
          sendResponse({ ok: true, active: state.active });
          break;
        case "DEACTIVATE":
          deactivate();
          sendResponse({ ok: true, active: state.active });
          break;
        case "SETTINGS_UPDATED":
          await loadSettings();
          // モード中で無効化された場合は OFF
          if (!state.siteEnabled && state.active) deactivate();
          sendResponse({ ok: true });
          break;
        case "RELEASE_SCROLL":
          releaseScrollLock();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown_message" });
      }
    })();
    return true; // async sendResponse
  });

  // ===== postMessage 受信 (フレーム間連携) =====
  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.__popup_eraser__ !== true) return;
    switch (data.type) {
      case "ACTIVATE":
        await loadSettings();
        activate();
        break;
      case "DEACTIVATE":
        deactivate();
        break;
      case "FRAME_DELETED":
        // 子フレームで削除されたものをトップのカウンタに加算
        if (IS_TOP && state.active) {
          state.deletedCount++;
          bumpCounter();
        }
        break;
    }
  });

  // 初期化
  loadSettings().catch(err => log("設定読込エラー", err));
})();
