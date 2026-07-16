/**
 * Next.js instrumentation(服务端启动钩子)——拉起 Web Push 派发器
 * (常驻订阅 bridge 事件流,回给 api 用户的 reply → 推送)。
 * dev/prod 都会执行;dispatcher 自身幂等(globalThis 单例)。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPushDispatcher } = await import("@/lib/push/dispatcher");
    startPushDispatcher();
  }
}
