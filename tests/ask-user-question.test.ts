/**
 * v2.0.19+ AskUserQuestion 适配 —— 单测 detectAskUserQuestion + buildAuqKeystrokes
 *
 * detectAskUserQuestion 是从 jsonl 抽取 questions 数组的纯函数。
 * buildAuqKeystrokes 是把 selections 翻译成 tmux 按键序列的纯函数。
 */

import { describe, test, expect } from "bun:test";
import {
  detectAskUserQuestion,
  buildAuqKeystrokes,
  type AuqQuestion,
  type AuqState,
} from "../src/bridge/ask-user-question.ts";

function mkAuqContent(questions: any[]): any[] {
  return [
    { type: "text", text: "asking" },
    {
      type: "tool_use",
      id: "tool_1",
      name: "AskUserQuestion",
      input: { questions },
    },
  ];
}

function mkState(questions: AuqQuestion[], selections: number[][]): AuqState {
  return {
    channelId: "ch1",
    questions,
    selections,
    messageId: "m1",
    tmuxTarget: "master:agent-foo",
    ts: Date.now(),
  };
}

describe("detectAskUserQuestion", () => {
  test("识别 AskUserQuestion tool_use", () => {
    const content = mkAuqContent([
      {
        question: "选房？",
        header: "选房",
        options: [
          { label: "A 区", description: "近地铁" },
          { label: "B 区", description: "便宜" },
        ],
        multiSelect: false,
      },
    ]);
    const qs = detectAskUserQuestion(content);
    expect(qs).not.toBeNull();
    expect(qs!.length).toBe(1);
    expect(qs![0].header).toBe("选房");
    expect(qs![0].options.length).toBe(2);
    expect(qs![0].multiSelect).toBe(false);
  });

  test("多 question + multiSelect", () => {
    const content = mkAuqContent([
      {
        question: "管家范围？",
        header: "管家",
        multiSelect: true,
        options: [
          { label: "信息问答" },
          { label: "缴费提醒" },
          { label: "报修反馈" },
        ],
      },
      {
        question: "合同房源？",
        header: "合同",
        multiSelect: true,
        options: [{ label: "续约" }, { label: "退租" }],
      },
    ]);
    const qs = detectAskUserQuestion(content);
    expect(qs).not.toBeNull();
    expect(qs!.length).toBe(2);
    expect(qs![0].multiSelect).toBe(true);
    expect(qs![0].options.length).toBe(3);
    expect(qs![1].options.length).toBe(2);
  });

  test("没 AskUserQuestion → null", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
    ];
    expect(detectAskUserQuestion(content)).toBeNull();
  });

  test("options 不足 2 个的 question 过滤掉", () => {
    const content = mkAuqContent([
      {
        question: "single?",
        options: [{ label: "only" }],
      },
    ]);
    expect(detectAskUserQuestion(content)).toBeNull();
  });

  test("label/description 超长截断", () => {
    const longLabel = "a".repeat(200);
    const content = mkAuqContent([
      {
        question: "test",
        options: [
          { label: longLabel, description: longLabel },
          { label: "b" },
        ],
      },
    ]);
    const qs = detectAskUserQuestion(content)!;
    expect(qs[0].options[0].label.length).toBeLessThanOrEqual(100);
    expect(qs[0].options[0].description!.length).toBeLessThanOrEqual(100);
  });
});

describe("buildAuqKeystrokes", () => {
  const q3: AuqQuestion = {
    question: "Q1?", header: "Q1", multiSelect: true,
    options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  };
  const q2: AuqQuestion = {
    question: "Q2?", header: "Q2", multiSelect: true,
    options: [{ label: "x" }, { label: "y" }],
  };

  test("单 question 选项 0 → Enter Right Enter", () => {
    const state = mkState([q3], [[0]]);
    // cursor 起始 0，optIdx 0：diff 0 不 Down，Enter 切；Right 去 Submit；Enter 提交
    expect(buildAuqKeystrokes(state)).toEqual(["Enter", "Right", "Enter"]);
  });

  test("单 question 选项 [0, 2] → Enter Down Down Enter Right Enter", () => {
    const state = mkState([q3], [[0, 2]]);
    expect(buildAuqKeystrokes(state)).toEqual([
      "Enter",       // toggle 0
      "Down", "Down", // cursor → 2
      "Enter",       // toggle 2
      "Right",       // → Submit section
      "Enter",       // submit
    ]);
  });

  test("两 question：Q1=[0,2], Q2=[1]", () => {
    const state = mkState([q3, q2], [[0, 2], [1]]);
    expect(buildAuqKeystrokes(state)).toEqual([
      "Enter",       // Q1 toggle 0
      "Down", "Down", "Enter",  // Q1 toggle 2
      "Right",       // → Q2
      "Down", "Enter", // Q2 toggle 1
      "Right",       // → Submit
      "Enter",       // submit
    ]);
  });

  test("空选择（用户不选直接 submit）也能跑出键序列", () => {
    const state = mkState([q3, q2], [[], []]);
    // 不切任何 [ ]，直接 Right Right Enter 提交
    expect(buildAuqKeystrokes(state)).toEqual(["Right", "Right", "Enter"]);
  });

  test("乱序 selections 内部 sort 后处理", () => {
    const state = mkState([q3], [[2, 0]]); // 没 sort
    // sort 后 [0, 2]，跟前面的 case 一样
    expect(buildAuqKeystrokes(state)).toEqual([
      "Enter", "Down", "Down", "Enter", "Right", "Enter",
    ]);
  });
});
