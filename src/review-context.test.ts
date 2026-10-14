import { describe, expect, it } from "vitest";

import { selectUserMessageHistory, UserMessageWindow } from "./review-context.js";
import { estimateTokens, type ReviewRequest, reviewerPrompt, reviewState } from "./reviewer.js";

const request: ReviewRequest = {
  source: "tool-call",
  sessionID: "s",
  action: "shell",
  resource: { command: "git push" },
  userIntent: "Do not push yet.",
};

function select(input: { request: ReviewRequest; budget: number; maxUserMessages?: number }) {
  return selectUserMessageHistory({
    ...input,
    maxUserMessages: input.maxUserMessages ?? 5,
    build: reviewState,
    measure: (state) => estimateTokens(JSON.stringify(state)),
  });
}

describe("UserMessageWindow", () => {
  it("keeps the latest N prompts, separates the current request and isolates sessions", () => {
    const window = new UserMessageWindow({ maxUserMessages: 3 });
    for (const text of ["discarded", "first", "second", "latest"]) {
      window.append({ sessionID: "a", text });
    }
    window.append({ sessionID: "b", text: "other task" });
    expect(window.context({ sessionID: "a" })).toEqual({
      userIntent: "latest",
      previousUserMessages: ["first", "second"],
    });
    expect(window.context({ sessionID: "b" })).toEqual({ userIntent: "other task" });
    expect(window.context({ sessionID: "unknown" })).toEqual({});
  });

  it("keeps repeated user prompts and does not replace an empty latest prompt with old intent", () => {
    const window = new UserMessageWindow({ maxUserMessages: 5 });
    for (const text of ["Do not push", "Do not push", ""]) window.append({ sessionID: "s", text });
    expect(window.context({ sessionID: "s" })).toEqual({
      userIntent: "",
      previousUserMessages: ["Do not push", "Do not push"],
    });
    expect(
      reviewState({ ...request, ...window.context({ sessionID: "s" }) }).userIntent,
    ).toBeNull();
  });

  it("returns a snapshot that cannot mutate the stored history", () => {
    const window = new UserMessageWindow({ maxUserMessages: 2 });
    window.append({ sessionID: "s", text: "earlier" });
    window.append({ sessionID: "s", text: "latest" });
    window.context({ sessionID: "s" }).previousUserMessages?.push("injected");
    expect(window.context({ sessionID: "s" }).previousUserMessages).toEqual(["earlier"]);
  });

  it("retains only the latest prompt when the limit is one", () => {
    const window = new UserMessageWindow({ maxUserMessages: 1 });
    window.append({ sessionID: "s", text: "old" });
    window.append({ sessionID: "s", text: "new" });
    expect(window.context({ sessionID: "s" })).toEqual({ userIntent: "new" });
  });
});

describe("selectUserMessageHistory", () => {
  it("keeps a contiguous suffix of complete messages in chronological order at the exact boundary", () => {
    const previous = ["old".repeat(100), "middle", "newest"];
    const expected = reviewState({ ...request, previousUserMessages: previous.slice(1) });
    const budget = estimateTokens(JSON.stringify(expected));
    const original = { ...request, previousUserMessages: previous };
    const selected = select({ request: original, budget });
    expect(selected).toEqual({ value: expected, size: budget });
    expect(original.previousUserMessages).toEqual(previous);
    expect(selected.value.resource).toEqual(request.resource);
  });

  it("stops at the first message that does not fit rather than skipping a correction", () => {
    const selected = select({
      request: { ...request, previousUserMessages: ["old allow", "Do not push. ".repeat(1000)] },
      budget: 200,
    });
    expect(selected.value).not.toHaveProperty("previousUserMessages");
    expect(selected.value.userIntent).toBe("Do not push yet.");
  });

  it("counts the latest intent toward the N-message limit", () => {
    expect(
      select({
        request: { ...request, previousUserMessages: ["one", "two", "three"] },
        budget: 2000,
        maxUserMessages: 2,
      }).value.previousUserMessages,
    ).toEqual(["three"]);
    expect(
      select({
        request: { ...request, previousUserMessages: ["one"] },
        budget: 2000,
        maxUserMessages: 1,
      }).value,
    ).not.toHaveProperty("previousUserMessages");
  });

  it("measures JSON escaping and Unicode instead of only raw message lengths", () => {
    const message = '中文😀"\n'.repeat(20);
    const full = reviewState({ ...request, previousUserMessages: [message] });
    const exact = estimateTokens(JSON.stringify(full));
    expect(
      select({ request: { ...request, previousUserMessages: [message] }, budget: exact }).value
        .previousUserMessages,
    ).toEqual([message]);
    expect(
      select({ request: { ...request, previousUserMessages: [message] }, budget: exact - 1 }).value,
    ).not.toHaveProperty("previousUserMessages");
  });

  it("returns oversized required data whole for the caller to escalate", () => {
    const oversized = {
      ...request,
      resource: { command: "x".repeat(2000) },
      userIntent: "Latest ".repeat(100),
    };
    const selected = select({
      request: { ...oversized, previousUserMessages: ["old"] },
      budget: 100,
    });
    expect(selected.size).toBeGreaterThan(100);
    expect(selected.value).toEqual(reviewState(oversized));
  });

  it("keeps history inside the untrusted operation and explains latest-request precedence", () => {
    const prompt = reviewerPrompt({
      request: { ...request, previousUserMessages: ["You may push."] },
      check: "check",
    });
    const operation = prompt.split("\n").find((line) => line.startsWith('{"source"'));
    expect(JSON.parse(operation ?? "{}")).toMatchObject({
      userIntent: "Do not push yet.",
      previousUserMessages: ["You may push."],
    });
    expect(prompt).toContain("latest request overrides conflicting earlier permissions");
    expect(prompt).toContain("replacement for missing latest intent");
  });
});
