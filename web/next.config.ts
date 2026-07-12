import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 / ssh2 是原生模块，不能被 bundler 打包，交给 Node require
  serverExternalPackages: ["better-sqlite3", "ssh2"],
  // 允许经 Tailscale / 局域网 IP 访问 dev server 的 _next 资源（否则 Next 16 dev 对
  // 跨源 _next 请求告警，未来版本会直接拦）。手机走 Tailscale 测网页版时用得上。
  // 127.0.0.1：本机 Playwright 自动化测试——不在列表里 HMR websocket 握手会一直失败，
  // dev 页面周期性整页 reload（store 重挂、视图闪回空白），肉眼看着像灵异 bug。
  allowedDevOrigins: ["100.120.71.107", "192.168.3.168", "127.0.0.1"],
};

export default nextConfig;
