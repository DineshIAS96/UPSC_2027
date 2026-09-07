/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION-CLIENT.JS
   Include this AFTER your existing `navigator.serviceWorker.register("sw.js")`
   call, e.g.:

     <script>
       window.NOTIFICATION_API = window.NOTIFICATION_API ||
         "https://YOUR-RENDER-SERVICE.onrender.com"; // set once, works on
                                                       // every GitHub Pages copy
     </script>
     <script src="notification-client.js"></script>

   It never assumes your markup — if you already have a bell icon element,
   give it id="notifBell" and this script will wire it up; otherwise it
   injects a small floating bell automatically so nothing is ever missing.

   If your app already exposes the logged-in student as `window.student`
   ({id,name,mobile,gender,email}), this script uses it automatically and
   re-links anonymous subscriptions the moment it appears (Google Sign-In,
   registration, etc.) — no changes needed to your existing login flow.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const API = window.NOTIFICATION_API || "";
  if (!API) { console.warn("[Notify] window.NOTIFICATION_API not set — notification system disabled."); return; }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("[Notify] Push not supported in this browser.");
    return;
  }

  const LS_DEVICE_ID = "notif_device_id";
  const LS_SUB_LINKED = "notif_last_linked_email";

  function deviceId() {
    let id = null;
    try { id = window.localStorage.getItem(LS_DEVICE_ID); } catch (e) { }
    if (!id) {
      id = "DEV_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
      try { window.localStorage.setItem(LS_DEVICE_ID, id); } catch (e) { }
    }
    return id;
  }

  function currentStudent() {
    return window.student || window.currentStudent || null;
  }

  async function api(path, opts) {
    // fetch() never times out on its own — if the backend stalls (e.g. a
    // slow Google Sheets call on Render), this would previously hang
    // forever ("Sending subscription to backend..." never resolving).
    // Abort after 15s so callers get a clear, fast failure instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(API + path, Object.assign({
        headers: { "Content-Type": "application/json" },
        signal: controller.signal
      }, opts || {}));
      if (!res.ok) throw new Error("API " + path + " -> " + res.status);
      return await res.json();
    } catch (err) {
      if (err.name === "AbortError") throw new Error("API " + path + " timed out after 15s");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function b64ToUint8(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // ── STATE ──
  let vapidPublicKey = null;
  let currentSubscriptionId = null;

  async function getVapidKey() {
    if (vapidPublicKey) return vapidPublicKey;
    const r = await api("/vapid-public-key");
    vapidPublicKey = r.key;
    return vapidPublicKey;
  }

  // Guards against overlapping calls: automatic init(), the granted-permission
  // branch of init(), and the 3s login re-link poller can all try to call
  // ensureSubscription() around the same moment. Without this, they'd race
  // to create/sync subscriptions concurrently.
  let _ensureSubscriptionInFlight = null;

  function ensureSubscription() {
    if (_ensureSubscriptionInFlight) return _ensureSubscriptionInFlight;
    _ensureSubscriptionInFlight = _ensureSubscriptionImpl().finally(() => {
      _ensureSubscriptionInFlight = null;
    });
    return _ensureSubscriptionInFlight;
  }

  async function _ensureSubscriptionImpl() {
  console.log("[Notify] ===== ensureSubscription START =====");
  console.log("[Notify] Notification permission:", Notification.permission);
  console.log("[Notify] ServiceWorker supported:", "serviceWorker" in navigator);
  console.log("[Notify] PushManager supported:", "PushManager" in window);

  try {
    if (Notification.permission !== "granted") {
      console.warn(
        "[Notify] Permission is not granted:",
        Notification.permission
      );
      return null;
    }

    // Service Worker ready
    console.log("[Notify] Waiting for Service Worker...");

    const reg = await navigator.serviceWorker.ready;

    console.log("[Notify] Service Worker ready");
    console.log("[Notify] SW scope:", reg.scope);
    console.log(
      "[Notify] SW active:",
      !!reg.active
    );

    // Existing subscription check
    let sub = await reg.pushManager.getSubscription();

    console.log(
      "[Notify] Existing push subscription:",
      sub ? "YES" : "NO"
    );

    // Create new subscription
    if (!sub) {
      console.log("[Notify] Getting VAPID public key...");

      const key = await getVapidKey();

      console.log(
        "[Notify] VAPID key received:",
        key ? "YES" : "NO"
      );

      console.log(
        "[Notify] VAPID key length:",
        key ? key.length : 0
      );

      console.log("[Notify] Creating Push subscription...");

      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToUint8(key)
        });

        console.log(
          "[Notify] ✅ Push subscription CREATED"
        );

      } catch (pushError) {

        console.error(
          "[Notify] ❌ pushManager.subscribe FAILED:",
          pushError
        );

        console.error(
          "[Notify] Error name:",
          pushError.name
        );

        console.error(
          "[Notify] Error message:",
          pushError.message
        );

        alert(
          "❌ Push Subscription Failed\n\n" +
          "Error: " +
          pushError.name +
          "\n\n" +
          pushError.message
        );

        return null;
      }
    }

    // Backend sync
    console.log("[Notify] Sending subscription to backend...");

    await syncSubscriptionToBackend(sub);

    console.log(
      "[Notify] ✅ Subscription synced with backend"
    );

    console.log("[Notify] ===== ensureSubscription END =====");

    return sub;

  } catch (err) {

    console.error(
      "[Notify] ❌ ensureSubscription FAILED:",
      err
    );

    console.error(
      "[Notify] Error name:",
      err.name
    );

    console.error(
      "[Notify] Error message:",
      err.message
    );

    alert(
      "❌ Notification Setup Failed\n\n" +
      "Error: " +
      err.name +
      "\n\n" +
      err.message
    );

    return null;
  }
}

  async function syncSubscriptionToBackend(sub) {
    const json = sub.toJSON();
    const st = currentStudent() || {};
    const body = {
      subscriptionId: currentSubscriptionId || deviceId(),
      endpoint: json.endpoint,
      keys: json.keys,
      appOrigin: window.location.origin,
      userAgent: navigator.userAgent,
      pwaInstalled: window.matchMedia("(display-mode: standalone)").matches,
      name: st.name || "", mobile: st.mobile || "", gender: st.gender || "",
      email: st.email || "", studentId: st.id || ""
    };
    try {
      const r = await api("/subscribe", { method: "POST", body: JSON.stringify(body) });
      currentSubscriptionId = r.subscriptionId || body.subscriptionId;
      if (st.email) { try { window.localStorage.setItem(LS_SUB_LINKED, st.email); } catch (e) { } }
      updateBellUI("granted");
    } catch (e) { console.warn("[Notify] subscribe sync failed", e); }
  }

  async function requestPermissionFlow(auto) {
    if (Notification.permission === "granted") { await ensureSubscription(); return; }
    if (Notification.permission === "denied") { if (!auto) showBlockedModal(); return; }
    // default — safe to ask, non-blocking
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") await ensureSubscription();
      updateBellUI(perm);
    } catch (e) { /* ignore */ }
  }

  // ── Re-link anonymous subscription the moment a student logs in ──
  let lastLinkedCheck = "";
  setInterval(() => {
    const st = currentStudent();
    if (st && st.email && st.email !== lastLinkedCheck) {
      lastLinkedCheck = st.email;
      let already = "";
      try { already = window.localStorage.getItem(LS_SUB_LINKED) || ""; } catch (e) { }
      if (already !== st.email) ensureSubscription();
    }
  }, 3000);

  // ═════════════════════════ BELL ICON ═════════════════════════
  function updateBellUI(state) {
    const bell = document.getElementById("notifBell") || document.getElementById("notif-fab-bell");
    if (!bell) return;
    bell.setAttribute("data-notif-state", state);
    const icon = state === "denied" ? "⚠️" : (state === "granted" ? "🔔" : "🔔");
    const dot = bell.querySelector(".notif-dot");
    if (dot) dot.style.display = state === "denied" ? "block" : (state === "default" ? "block" : "none");
    if (dot) dot.style.background = state === "denied" ? "#e11d48" : "#eab308";
    if (!bell.dataset.notifIconSet) bell.textContent = bell.textContent || icon;
  }

  function ensureFallbackBell() {
    if (document.getElementById("notifBell")) return document.getElementById("notifBell");
    if (document.getElementById("notif-fab-bell")) return document.getElementById("notif-fab-bell");
    const btn = document.createElement("button");
    btn.id = "notif-fab-bell";
    btn.setAttribute("aria-label", "Notifications");
    btn.textContent = "🔔";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9998;width:52px;height:52px;" +
      "border-radius:50%;border:none;background:#1f2430;color:#fff;font-size:22px;cursor:pointer;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;";
    const badge = document.createElement("span");
    badge.className = "notif-badge-count";
    badge.style.cssText = "position:absolute;top:-4px;right:-4px;background:#e11d48;color:#fff;" +
      "font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:none;" +
      "align-items:center;justify-content:center;padding:0 4px;";
    btn.style.position = "fixed";
    btn.appendChild(badge);
    document.body.appendChild(btn);
    return btn;
  }

  function wireBell() {
    const bell = ensureFallbackBell();
    bell.addEventListener("click", () => {
      if (Notification.permission === "denied") { showBlockedModal(); return; }
      if (Notification.permission === "default") { requestPermissionFlow(false); return; }
      openNotificationCenter();
    });
    updateBellUI(Notification.permission);
  }

  function showBlockedModal() {
    const overlay = createOverlay();
    overlay.querySelector(".notif-modal").innerHTML =
      '<h3 style="margin:0 0 10px">🔔 Notifications अभी Block हैं</h3>' +
      '<p style="margin:0 0 16px;line-height:1.5">Browser Settings में जाकर इस website के Notifications को Allow करें, ' +
      'फिर वापस app में आएं — subscription अपने आप sync हो जाएगी।</p>' +
      '<button class="notif-btn-primary" id="notifModalClose">ठीक है</button>';
    document.getElementById("notifModalClose").onclick = () => overlay.remove();
  }

  function createOverlay() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;" +
      "display:flex;align-items:center;justify-content:center;padding:16px;";
    const modal = document.createElement("div");
    modal.className = "notif-modal";
    modal.style.cssText = "background:#161a22;color:#eee;padding:20px;border-radius:14px;" +
      "max-width:380px;width:100%;font-family:inherit;";
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  // ═════════════════════ NOTIFICATION CENTER ═════════════════════
  let ncOverlay = null;

  function injectStyles() {
    if (document.getElementById("notif-center-style")) return;
    const style = document.createElement("style");
    style.id = "notif-center-style";
    style.textContent = `
      .nc-overlay{position:fixed;inset:0;background:#0f1117;z-index:99997;display:flex;flex-direction:column;
        min-width:0;max-width:100%;overflow:hidden;}
      .nc-header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #262b36;
        background:#141822;flex-shrink:0;}
      .nc-back{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:6px 10px;
        border-radius:8px;}
      .nc-back:active{background:#232838;}
      .nc-title{color:#fff;font-weight:700;font-size:16px;flex:1;}
      .nc-list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0;}
      .nc-card{background:#171b26;border:1px solid #262b36;border-radius:14px;padding:14px;color:#e8e8ef;
        min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word;position:relative;}
      .nc-card.unread{border-color:#3b82f6;}
      .nc-new-badge{position:absolute;top:12px;right:12px;background:#3b82f6;color:#fff;font-size:10px;
        font-weight:700;padding:2px 8px;border-radius:10px;}
      .nc-card-title{font-weight:700;font-size:15px;margin:0 0 6px;padding-right:46px;}
      .nc-card-sub{font-size:12px;color:#9aa3b2;margin-bottom:8px;}
      .nc-card-msg{font-size:14px;line-height:1.5;white-space:pre-wrap;max-width:100%;}
      .nc-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
      .nc-seemore{background:none;border:none;color:#60a5fa;font-size:13px;padding:6px 0 0;cursor:pointer;}
      .nc-img{width:100%;max-width:100%;border-radius:10px;margin:8px 0;cursor:zoom-in;display:block;}
      .nc-meta{font-size:12px;color:#8b93a3;margin-top:10px;line-height:1.6;}
      .nc-btn{margin-top:10px;background:#2563eb;border:none;color:#fff;padding:9px 14px;border-radius:9px;
        font-size:13px;font-weight:600;cursor:pointer;}
      .nc-empty,.nc-loading,.nc-error{color:#9aa3b2;text-align:center;padding:60px 20px;}
      .nc-retry{margin-top:12px;background:#2563eb;border:none;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;}
      .nc-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:99999;display:flex;
        align-items:center;justify-content:center;padding:16px;}
      .nc-lightbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;}
      .nc-lightbox-close{position:absolute;top:16px;right:16px;background:rgba(255,255,255,.15);border:none;
        color:#fff;width:36px;height:36px;border-radius:50%;font-size:18px;cursor:pointer;}
      .notif-btn-primary{background:#2563eb;border:none;color:#fff;padding:10px 18px;border-radius:9px;
        font-weight:600;cursor:pointer;}
      @media (prefers-reduced-motion: reduce){ .nc-overlay{transition:none!important;} }
    `;
    document.head.appendChild(style);
  }

  function fmtDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function cardHtml(n) {
    const isScheduled = n.type === "scheduled_test";
    const title = isScheduled ? "📚 " + (n.title || "Test Starting Soon") : "📢 " + (n.title || "Important Update");
    const subLine = isScheduled ? [n.subject, n.source, n.plan].filter(Boolean).join(" • ") : "";
    const msg = n.message || "";
    const needsClamp = msg.length > 160;
    const imgHtml = n.imageUrl ? `<img class="nc-img" src="${escAttr(n.imageUrl)}" alt="notification image" onerror="this.style.display='none'">` : "";
    let metaHtml = `<div class="nc-meta">`;
    if (isScheduled && n.scheduleTime) metaHtml += `📅 Test Time: ${fmtDateTime(n.scheduleTime)}<br>`;
    metaHtml += `🕒 ${isScheduled ? "Notification Sent" : ""}: ${fmtDateTime(n.sentAt)}`;
    metaHtml += `</div>`;
    const openBtn = (isScheduled && n.url) ? `<button class="nc-btn" data-open-url="${escAttr(n.url)}">📝 Open Test</button>` :
      ((!isScheduled && n.url) ? `<button class="nc-btn" data-open-url="${escAttr(n.url)}">Open</button>` : "");

    return `
      <div class="nc-card ${n.read ? "" : "unread"}" data-id="${escAttr(n.notificationId)}">
        ${n.read ? "" : '<span class="nc-new-badge">NEW</span>'}
        <p class="nc-card-title">${escHtml(title)}</p>
        ${subLine ? `<div class="nc-card-sub">${escHtml(subLine)}</div>` : ""}
        ${imgHtml}
        <div class="nc-card-msg ${needsClamp ? "nc-clamp" : ""}">${escHtml(msg)}</div>
        ${needsClamp ? `<button class="nc-seemore">See More</button>` : ""}
        ${metaHtml}
        ${openBtn}
      </div>`;
  }

  function escHtml(s) { return String(s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }

  async function openNotificationCenter() {
    injectStyles();
    if (ncOverlay) ncOverlay.remove();
    ncOverlay = document.createElement("div");
    ncOverlay.className = "nc-overlay";
    ncOverlay.innerHTML = `
      <div class="nc-header">
        <button class="nc-back" id="ncBackBtn">← Back</button>
        <div class="nc-title">🔔 Notifications</div>
      </div>
      <div class="nc-list" id="ncList"><div class="nc-loading">🔄 Loading notifications...</div></div>`;
    document.body.appendChild(ncOverlay);
    document.getElementById("ncBackBtn").onclick = closeNotificationCenter;
    await loadNotifications();
  }

  function closeNotificationCenter() {
    if (ncOverlay) { ncOverlay.remove(); ncOverlay = null; }
    refreshUnreadBadge();
  }

  async function loadNotifications() {
    const list = document.getElementById("ncList");
    const st = currentStudent();
    const q = st && st.email ? ("?email=" + encodeURIComponent(st.email)) :
      ("?subscriptionId=" + encodeURIComponent(currentSubscriptionId || deviceId()));
    try {
      const r = await api("/notifications" + q);
      const rows = r.notifications || [];
      if (!rows.length) {
        list.innerHTML = `<div class="nc-empty">🔔<br><br><b>No Notifications Yet</b><br>आपके लिए अभी कोई notification नहीं है।</div>`;
        return;
      }
      list.innerHTML = rows.map(cardHtml).join("");
      list.querySelectorAll(".nc-seemore").forEach(btn => {
        btn.addEventListener("click", () => {
          const msgEl = btn.previousElementSibling;
          const collapsed = msgEl.classList.toggle("nc-clamp");
          btn.textContent = collapsed ? "See More" : "See Less";
        });
      });
      list.querySelectorAll(".nc-img").forEach(img => {
        img.addEventListener("click", () => openLightbox(img.src));
      });
      list.querySelectorAll("[data-open-url]").forEach(btn => {
        btn.addEventListener("click", () => {
          const url = btn.getAttribute("data-open-url");
          window.location.href = new URL(url, window.location.origin).href;
        });
      });
      list.querySelectorAll(".nc-card").forEach(card => {
        card.addEventListener("click", (e) => {
          if (e.target.closest("button")) return;
          markRead(card.getAttribute("data-id"), card);
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="nc-error">Notifications load नहीं हो सकीं।<br><button class="nc-retry" id="ncRetry">Retry</button></div>`;
      const retry = document.getElementById("ncRetry");
      if (retry) retry.onclick = loadNotifications;
    }
  }

  async function markRead(notificationId, cardEl) {
    if (!notificationId || !cardEl.classList.contains("unread")) return;
    cardEl.classList.remove("unread");
    const badge = cardEl.querySelector(".nc-new-badge");
    if (badge) badge.remove();
    const st = currentStudent();
    try {
      await api("/notifications/read", {
        method: "POST",
        body: JSON.stringify({ notificationId: notificationId, email: st ? st.email : "", subscriptionId: currentSubscriptionId || deviceId() })
      });
    } catch (e) { /* best-effort */ }
    refreshUnreadBadge();
  }

  function openLightbox(src) {
    const box = document.createElement("div");
    box.className = "nc-lightbox";
    box.innerHTML = `<button class="nc-lightbox-close">✕</button><img src="${escAttr(src)}">`;
    box.addEventListener("click", (e) => { if (e.target === box || e.target.classList.contains("nc-lightbox-close")) box.remove(); });
    document.body.appendChild(box);
  }

  async function refreshUnreadBadge() {
    const st = currentStudent();
    const q = st && st.email ? ("?email=" + encodeURIComponent(st.email)) :
      ("?subscriptionId=" + encodeURIComponent(currentSubscriptionId || deviceId()));
    try {
      const r = await api("/notifications" + q);
      const unread = (r.notifications || []).filter(n => !n.read).length;
      const badgeEl = document.querySelector(".notif-badge-count");
      const bellText = unread > 99 ? "99+" : String(unread);
      if (badgeEl) { badgeEl.style.display = unread ? "flex" : "none"; badgeEl.textContent = bellText; }
      const customBell = document.getElementById("notifBell");
      if (customBell) customBell.setAttribute("data-unread", String(unread));
    } catch (e) { /* ignore */ }
  }

  // ── Handle SW → page messages (notification click while a tab is open) ──
  navigator.serviceWorker.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "notification-click") {
      if (msg.payload && msg.payload.notificationId) markRead(msg.payload.notificationId, { classList: { contains: () => true, remove: () => { } }, querySelector: () => null });
      if (msg.url) window.location.href = msg.url;
    }
  });

  // ── INIT ──
  function init() {
    wireBell();
    refreshUnreadBadge();
    setInterval(refreshUnreadBadge, 30000);
    // Automatic entry points — PWA open AND normal website open, both land here.
    requestAnimationFrame(() => requestPermissionFlow(true));
    if (Notification.permission === "granted") ensureSubscription();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") init();
  else document.addEventListener("DOMContentLoaded", init);

  window.NotificationSystem = { openNotificationCenter, requestPermissionFlow, ensureSubscription };
})();
