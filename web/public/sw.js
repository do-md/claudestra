/**
 * Claudestra Web Push Service Worker(owner 2026-07-16「做 pwa 推送」)。
 * - push:展示通知;若已有聚焦中的 App 窗口(人正在看)则不弹横幅,免打扰
 * - notificationclick:聚焦已有窗口,没有则新开 /chat
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = { title: "Claudestra", body: "", url: "/chat", tag: "cstra", agent: "" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    /* 非 JSON payload,用默认 */
  }
  event.waitUntil(
    // ⚠ 必须无条件 showNotification——iOS/Safari 对「push 到达却不展示」有
    // 惩罚:静默几次后开始丢弃该订阅的后续推送(2026-07-16 真机实锤:一版
    // 「前台聚焦不弹」把用户开着页面期间的推送全静默,随后通知全部收不到)。
    // 前台重复感靠 tag 折叠缓解;绝不静默。
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url, agent: payload.agent },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/chat";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          // 已有窗口:postMessage 让页面原地切到该 agent 会话(比 navigate 整页
          // 刷新顺滑;owner 2026-07-16「点通知切到具体 agent」)
          if (data.agent) w.postMessage({ type: "cstra-open-agent", agent: data.agent });
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
