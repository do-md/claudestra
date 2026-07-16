"use client";

/**
 * Web Push 客户端共用逻辑(owner 2026-07-16「引导用户允许推送权限」):
 * 设置页开关与首页引导条共用同一套订阅/退订流程。
 * 注意:Notification.requestPermission 必须发生在用户手势里(浏览器强制,
 * iOS 尤其严格)——调用方只能是按钮 onClick。
 */

/** base64url VAPID 公钥 → Uint8Array(pushManager.subscribe 要求)。 */
function urlB64ToUint8(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** 当前环境是否具备推送能力(iOS 非主屏打开时 PushManager 不存在)。 */
export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;
}

/** 本设备现有订阅(null=未订阅/不支持)。 */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** 开启推送:权限 → 订阅 → 入库。必须在用户手势里调用。 */
export async function enablePush(): Promise<{ ok: boolean; msg: string }> {
  if (!pushSupported()) {
    return { ok: false, msg: "此环境不支持推送(iOS 需先「添加到主屏幕」并从主屏打开)" };
  }
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      return { ok: false, msg: "通知权限被拒绝——请在系统设置里允许后重试" };
    }
    const keyRes = await fetch("/api/push");
    const keyJson = (await keyRes.json()) as { data?: { publicKey: string } };
    if (!keyJson.data?.publicKey) throw new Error("no key");
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(keyJson.data.publicKey) as BufferSource,
      }));
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, msg: "已开启:Web 端发起的对话有回复时推送到本设备" };
  } catch (e) {
    return { ok: false, msg: `开启失败:${(e as Error).message}(需要 HTTPS 或安装到主屏幕)` };
  }
}

/** 关闭推送:退订 + 从服务端删除。 */
export async function disablePush(): Promise<{ ok: boolean; msg: string }> {
  const sub = await getPushSubscription();
  if (!sub) return { ok: true, msg: "本设备未订阅" };
  try {
    await fetch("/api/push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
    return { ok: true, msg: "已关闭本设备推送" };
  } catch (e) {
    return { ok: false, msg: `关闭失败:${(e as Error).message}` };
  }
}
