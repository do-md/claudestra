/**
 * 工具详情的语法高亮（highlight.js core + 按需语言,打包只含注册的子集）。
 *
 * token 颜色不用官方主题 CSS——globals.css 里用 daisyUI 主题变量手写十来条
 * .hljs-* 规则,亮暗主题自动跟随（官方主题是固定色,双主题要引两套还要打架）。
 * hljs v11 输出自带 HTML escape,dangerouslySetInnerHTML 安全;任何异常兜底
 * 手动 escape 的纯文本。
 */
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 按文件扩展名推语言（推不出返回 undefined → 调用方走 auto/纯文本）。 */
export function langForPath(filePath?: string): string | undefined {
  const ext = filePath?.trim().split(".").pop()?.toLowerCase();
  return ext ? EXT_LANG[ext] : undefined;
}

/**
 * 代码 → 高亮 HTML。lang 给定用它;否则内容够长才 highlightAuto（短文本
 * 自动检测常错判,不如素着）。失败/无语言兜底 escape 纯文本。
 */
export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    if (code.length >= 40) {
      const auto = hljs.highlightAuto(code);
      if ((auto.relevance ?? 0) >= 5) return auto.value;
    }
  } catch {
    /* fallthrough */
  }
  return escapeHtml(code);
}
