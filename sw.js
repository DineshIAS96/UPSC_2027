// ═══════════════════════════════════════════════════════════
//  SERVICE WORKER — existing install/activate/fetch UNCHANGED.
//  Added: push + notificationclick for the notification system.
//  No production URL is hardcoded anywhere below — everything
//  resolves relative to self.registration.scope, so this exact
//  file works unmodified on app-download AND UPSC_2027 (or any
//  other GitHub Pages path).
// ═══════════════════════════════════════════════════════════
const CACHE_NAME = "upsc-mcq-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── PUSH — Python Render backend sends a JSON payload; we just render it ──
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: "🔔 Notification", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "🔔 Test Starting Soon";
  const options = {
    body: data.body || "",
    icon: data.icon || "icon-192.png",
    badge: data.badge || "icon-192.png",
    // ✅ image field renders the manual-notification image (if present) —
    // browsers that don't support `image` simply ignore it, no crash.
    image: data.imageUrl || undefined,
    tag: data.notificationKey || data.quizId || undefined, // collapses dup pushes for the same tag
    renotify: !!data.notificationKey,
    data: {
      type: data.type || "scheduled_test",       // "scheduled_test" | "manual_student" | "test"
      quizId: data.quizId || "",
      notificationId: data.notificationId || "",
      // ✅ relative route ONLY — never an absolute GitHub Pages URL.
      // Resolved against this SW's own scope at click-time (see below).
      url: data.url || "./"
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── NOTIFICATION CLICK — opens/focuses the app at a scope-relative URL ──
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const targetUrl = new URL(payload.url || "./", self.registration.scope).href;

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });

    // Reuse an already-open tab of THIS app if one exists — then tell the
    // page (via postMessage) which notification was opened, so the
    // frontend can navigate to the test / mark it read without a reload.
    for (const client of allClients) {
      if (client.url.indexOf(self.registration.scope) === 0) {
        client.postMessage({ type: "notification-click", payload: payload, url: targetUrl });
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});
