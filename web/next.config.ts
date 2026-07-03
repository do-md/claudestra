import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 / ssh2 是原生模块，不能被 bundler 打包，交给 Node require
  serverExternalPackages: ["better-sqlite3", "ssh2"],
};

export default nextConfig;
