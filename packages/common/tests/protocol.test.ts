import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessage, parseMessage } from "../src/protocol.js";
import type { WsMessage, WorkerRegisterPayload } from "../src/types.js";

describe("createMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create a message with type, payload, and timestamp", () => {
    const payload = { text: "hello" };
    const msg = createMessage("task:stream", payload);

    expect(msg.type).toBe("task:stream");
    expect(msg.payload).toEqual({ text: "hello" });
    expect(msg.timestamp).toBe(Date.now());
  });

  it("should include taskId when provided in options", () => {
    const payload = { resultText: "done", sessionId: null, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 100 };
    const msg = createMessage("task:complete", payload, { taskId: "task-123" });

    expect(msg.taskId).toBe("task-123");
    expect(msg.workerId).toBeUndefined();
  });

  it("should include workerId when provided in options", () => {
    const payload: WorkerRegisterPayload = {
      name: "worker-1",
      secret: "s3cret",
      os: "linux",
      nodeVersion: "v20.0.0",
      claudeCliVersion: "1.0.0",
      defaultCwd: "/home/user",
      allowedDirs: ["/home/user"],
      protocolVersion: "1.0.0",
    };
    const msg = createMessage("worker:register", payload, { workerId: "w-1" });

    expect(msg.workerId).toBe("w-1");
    expect(msg.taskId).toBeUndefined();
  });

  it("should include both taskId and workerId when provided", () => {
    const msg = createMessage("task:assign", { prompt: "do something" }, {
      taskId: "t-1",
      workerId: "w-1",
    });

    expect(msg.taskId).toBe("t-1");
    expect(msg.workerId).toBe("w-1");
  });

  it("should set timestamp to current time", () => {
    const now = Date.now();
    const msg = createMessage("worker:heartbeat", { status: "online", currentTaskId: null });
    expect(msg.timestamp).toBe(now);
  });
});

describe("parseMessage", () => {
  it("should parse a valid JSON message", () => {
    const original: WsMessage = {
      type: "worker:heartbeat",
      payload: { status: "online", currentTaskId: null },
      timestamp: 1700000000000,
    };
    const raw = JSON.stringify(original);
    const parsed = parseMessage(raw);

    expect(parsed.type).toBe("worker:heartbeat");
    expect(parsed.payload).toEqual({ status: "online", currentTaskId: null });
    expect(parsed.timestamp).toBe(1700000000000);
  });

  it("should preserve optional fields (taskId, workerId)", () => {
    const original: WsMessage = {
      type: "task:complete",
      taskId: "task-abc",
      workerId: "worker-1",
      payload: { resultText: "done" },
      timestamp: 1700000000000,
    };
    const raw = JSON.stringify(original);
    const parsed = parseMessage(raw);

    expect(parsed.taskId).toBe("task-abc");
    expect(parsed.workerId).toBe("worker-1");
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseMessage("not json")).toThrow();
  });

  it("should throw when type is missing", () => {
    const raw = JSON.stringify({ payload: {}, timestamp: 123 });
    expect(() => parseMessage(raw)).toThrow("Invalid WsMessage: missing required fields");
  });

  it("should throw when payload is missing", () => {
    const raw = JSON.stringify({ type: "worker:heartbeat", timestamp: 123 });
    expect(() => parseMessage(raw)).toThrow("Invalid WsMessage: missing required fields");
  });

  it("should throw when timestamp is missing", () => {
    const raw = JSON.stringify({ type: "worker:heartbeat", payload: {} });
    expect(() => parseMessage(raw)).toThrow("Invalid WsMessage: missing required fields");
  });

  it("should accept payload with value null", () => {
    const raw = JSON.stringify({ type: "task:cancel", payload: null, timestamp: 123 });
    // payload is null (not undefined), so it should pass the undefined check
    // but null is falsy... let's check the actual behavior
    // The check is: msg.payload === undefined
    // null !== undefined, so this should pass
    const parsed = parseMessage(raw);
    expect(parsed.payload).toBeNull();
  });

  it("should accept payload with value 0 or empty string", () => {
    const raw0 = JSON.stringify({ type: "task:cancel", payload: 0, timestamp: 123 });
    const parsed0 = parseMessage(raw0);
    expect(parsed0.payload).toBe(0);

    const rawEmpty = JSON.stringify({ type: "task:cancel", payload: "", timestamp: 123 });
    const parsedEmpty = parseMessage(rawEmpty);
    expect(parsedEmpty.payload).toBe("");
  });
});
