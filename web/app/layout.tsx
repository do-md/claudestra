import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudestra",
  description: "Claudestra Web 客户端 — 远程操控本地 Claude Code 会话",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Claudestra",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // prin-fc2966：PWA 必须 viewport-fit=cover，否则 env(safe-area-inset-*) 恒为 0
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "rgb(23,24,25)" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-full bg-base-100 text-base-content antialiased">
        {children}
      </body>
    </html>
  );
}
