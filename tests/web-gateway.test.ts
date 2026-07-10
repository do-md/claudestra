/**
 * v2.10+ web-gateway 单测：CORS 白名单匹配 / 静态路径解析（穿越防护 + SPA fallback）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { corsHeadersFor, resolveStaticPath } from "../src/bridge/web-gateway.js";

describe("corsHeadersFor", () => {
  test("未配置 → null（默认关闭）", () => {
    expect(corsHeadersFor("http://localhost:5173", "")).toBeNull();
  });

  test("* 通配：任意 origin 都发 *", () => {
    const h = corsHeadersFor("http://anything.example", "*");
    expect(h?.["Access-Control-Allow-Origin"]).toBe("*");
    expect(h?.Vary).toBeUndefined();
  });

  test("白名单精确匹配：命中回显 origin + Vary，未命中 null", () => {
    const setting = "http://localhost:5173, https://ui.example.com";
    const hit = corsHeadersFor("http://localhost:5173", setting);
    expect(hit?.["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(hit?.Vary).toBe("Origin");
    expect(corsHeadersFor("http://evil.example", setting)).toBeNull();
    expect(corsHeadersFor(null, setting)).toBeNull();
  });

  test("允许的 header 覆盖 SSE 场景（Authorization + Last-Event-ID）", () => {
    const h = corsHeadersFor("x", "*");
    expect(h?.["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(h?.["Access-Control-Allow-Headers"]).toContain("Last-Event-ID");
  });
});

describe("resolveStaticPath", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "static-"));
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "js");
    return root;
  }

  test("命中真实文件", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveStaticPath(root, "/index.html")).toBe(join(root, "index.html"));
  });

  test("SPA fallback：无扩展名路径回 index.html，缺失资源文件 404", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveStaticPath(root, "/agents/claudestra")).toBe(join(root, "index.html"));
    expect(resolveStaticPath(root, "/assets/missing.js")).toBeNull();
  });

  test("路径穿越与非法编码拦截", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveStaticPath(root, "/%zz")).toBeNull();
  });

  test("root 未设 → null", () => {
    expect(resolveStaticPath("", "/index.html")).toBeNull();
  });
});
