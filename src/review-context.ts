import type { ReviewRequest } from "./reviewer.js";

/** In-memory user prompts, isolated by session; a restart starts a fresh window. */
export class UserMessageWindow {
  readonly #maxUserMessages: number;
  readonly #messages = new Map<string, string[]>();

  constructor(input: { maxUserMessages: number }) {
    this.#maxUserMessages = input.maxUserMessages;
  }

  append(input: { sessionID: string; text: string }): void {
    const messages = this.#messages.get(input.sessionID) ?? [];
    this.#messages.set(input.sessionID, [...messages, input.text].slice(-this.#maxUserMessages));
  }

  context(input: {
    sessionID: string;
  }): Pick<ReviewRequest, "userIntent" | "previousUserMessages"> {
    const messages = this.#messages.get(input.sessionID);
    if (messages === undefined) return {};
    return {
      userIntent: messages.at(-1),
      ...(messages.length > 1 ? { previousUserMessages: messages.slice(0, -1) } : {}),
    };
  }
}

/**
 * Always keeps the operation and latest intent whole. Older messages are added
 * newest first until the first one that will not fit; no gap or partial message
 * can hide a newer correction while retaining an older authorization.
 * The caller handles an oversized required input through its existing fallback.
 */
export function selectUserMessageHistory<T>(input: {
  request: ReviewRequest;
  maxUserMessages: number;
  budget: number;
  build: (request: ReviewRequest) => T;
  measure: (value: T) => number;
}): { value: T; size: number } {
  const required = { ...input.request };
  delete required.previousUserMessages;
  let value = input.build(required);
  let size = input.measure(value);
  if (size > input.budget || input.maxUserMessages <= 1) return { value, size };

  const previous: string[] = [];
  const candidates = (input.request.previousUserMessages ?? []).slice(-(input.maxUserMessages - 1));
  for (const message of candidates.toReversed()) {
    previous.unshift(message);
    const candidate = input.build({ ...required, previousUserMessages: [...previous] });
    const candidateSize = input.measure(candidate);
    if (candidateSize > input.budget) break;
    value = candidate;
    size = candidateSize;
  }
  return { value, size };
}
