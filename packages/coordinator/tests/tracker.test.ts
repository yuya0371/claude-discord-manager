import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TokenTracker, TokenSummary, WorkerTokenSummary } from "../src/token/tracker.js";
import type { TokenUsage } from "@claude-discord/common";

function makeUsage(input = 100, output = 50, cacheRead = 10, cacheWrite = 5): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

describe("TokenTracker", () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new TokenTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- record() ---

  it("should record a token usage entry", () => {
    tracker.record("task-1", "worker-1", makeUsage());
    const records = tracker.getAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0].taskId).toBe("task-1");
    expect(records[0].workerId).toBe("worker-1");
    expect(records[0].usage.inputTokens).toBe(100);
  });

  it("should store timestamp on record", () => {
    const now = new Date(2026, 1, 25, 12, 0, 0).getTime();
    vi.setSystemTime(now);

    tracker.record("task-1", "worker-1", makeUsage());
    expect(tracker.getAllRecords()[0].timestamp).toBe(now);
  });

  it("should record multiple entries", () => {
    tracker.record("task-1", "worker-1", makeUsage(100));
    tracker.record("task-2", "worker-2", makeUsage(200));
    tracker.record("task-3", "worker-1", makeUsage(300));
    expect(tracker.getAllRecords()).toHaveLength(3);
  });

  // --- getAllRecords() ---

  it("should return a copy of records (not the internal array)", () => {
    tracker.record("task-1", "worker-1", makeUsage());
    const records = tracker.getAllRecords();
    records.push({ taskId: "fake", workerId: "fake", usage: makeUsage(), timestamp: 0 });
    expect(tracker.getAllRecords()).toHaveLength(1);
  });

  // --- getRecordsByDate() ---

  // Helper: create a local date at noon on a given year/month/day
  function localNoon(year: number, month: number, day: number): Date {
    return new Date(year, month - 1, day, 12, 0, 0);
  }
  function localTime(year: number, month: number, day: number, h: number, m: number, s: number): Date {
    return new Date(year, month - 1, day, h, m, s);
  }

  it("should return records for the current day by default", () => {
    vi.setSystemTime(localTime(2026, 2, 25, 10, 0, 0));
    tracker.record("task-1", "w1", makeUsage());

    vi.setSystemTime(localTime(2026, 2, 25, 23, 59, 59));
    tracker.record("task-2", "w1", makeUsage());

    const records = tracker.getRecordsByDate();
    expect(records).toHaveLength(2);
  });

  it("should exclude records from other days", () => {
    vi.setSystemTime(localNoon(2026, 2, 24));
    tracker.record("task-yesterday", "w1", makeUsage());

    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-today", "w1", makeUsage());

    vi.setSystemTime(localNoon(2026, 2, 26));
    tracker.record("task-tomorrow", "w1", makeUsage());

    const todayRecords = tracker.getRecordsByDate(localNoon(2026, 2, 25));
    expect(todayRecords).toHaveLength(1);
    expect(todayRecords[0].taskId).toBe("task-today");
  });

  it("should return empty array when no records exist for date", () => {
    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-1", "w1", makeUsage());

    const records = tracker.getRecordsByDate(localNoon(2026, 3, 1));
    expect(records).toHaveLength(0);
  });

  // --- getTodaySummary() ---

  it("should return zero summary when no records exist", () => {
    const summary = tracker.getTodaySummary();
    expect(summary).toEqual({
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      taskCount: 0,
    });
  });

  it("should sum today's token usage correctly", () => {
    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-1", "w1", makeUsage(100, 50, 10, 5));
    tracker.record("task-2", "w2", makeUsage(200, 100, 20, 10));

    const summary = tracker.getTodaySummary();
    expect(summary.totalInput).toBe(300);
    expect(summary.totalOutput).toBe(150);
    expect(summary.totalCacheRead).toBe(30);
    expect(summary.totalCacheWrite).toBe(15);
    expect(summary.taskCount).toBe(2);
  });

  // --- getCumulativeSummary() ---

  it("should return cumulative summary across all days", () => {
    vi.setSystemTime(localNoon(2026, 2, 24));
    tracker.record("task-1", "w1", makeUsage(100, 50, 10, 5));

    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-2", "w1", makeUsage(200, 100, 20, 10));

    vi.setSystemTime(localNoon(2026, 2, 26));
    tracker.record("task-3", "w2", makeUsage(300, 150, 30, 15));

    const cumulative = tracker.getCumulativeSummary();
    expect(cumulative.totalInput).toBe(600);
    expect(cumulative.totalOutput).toBe(300);
    expect(cumulative.totalCacheRead).toBe(60);
    expect(cumulative.totalCacheWrite).toBe(30);
    expect(cumulative.taskCount).toBe(3);
  });

  // --- getWorkerSummaries() ---

  it("should group summaries by worker", () => {
    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-1", "worker-1", makeUsage(100, 50, 10, 5));
    tracker.record("task-2", "worker-2", makeUsage(200, 100, 20, 10));
    tracker.record("task-3", "worker-1", makeUsage(300, 150, 30, 15));

    const summaries = tracker.getWorkerSummaries();
    expect(summaries).toHaveLength(2);

    const w1 = summaries.find((s) => s.workerId === "worker-1");
    expect(w1).toBeDefined();
    expect(w1!.summary.totalInput).toBe(400);
    expect(w1!.summary.totalOutput).toBe(200);
    expect(w1!.summary.taskCount).toBe(2);

    const w2 = summaries.find((s) => s.workerId === "worker-2");
    expect(w2).toBeDefined();
    expect(w2!.summary.totalInput).toBe(200);
    expect(w2!.summary.taskCount).toBe(1);
  });

  it("should return empty array when no records exist for worker summaries", () => {
    const summaries = tracker.getWorkerSummaries();
    expect(summaries).toEqual([]);
  });

  it("should filter worker summaries by date", () => {
    vi.setSystemTime(localNoon(2026, 2, 24));
    tracker.record("task-1", "w1", makeUsage(1000));

    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-2", "w1", makeUsage(200));
    tracker.record("task-3", "w2", makeUsage(300));

    const summaries = tracker.getWorkerSummaries(localNoon(2026, 2, 25));
    expect(summaries).toHaveLength(2);

    const w1 = summaries.find((s) => s.workerId === "w1");
    expect(w1!.summary.totalInput).toBe(200);
  });

  // --- getTaskDetails() ---

  it("should return today's task details by default", () => {
    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("task-1", "w1", makeUsage());
    tracker.record("task-2", "w2", makeUsage());

    const details = tracker.getTaskDetails();
    expect(details).toHaveLength(2);
    expect(details[0].taskId).toBe("task-1");
    expect(details[1].taskId).toBe("task-2");
  });

  it("should filter task details by specific date", () => {
    vi.setSystemTime(localNoon(2026, 2, 24));
    tracker.record("old-task", "w1", makeUsage());

    vi.setSystemTime(localNoon(2026, 2, 25));
    tracker.record("new-task", "w1", makeUsage());

    const details = tracker.getTaskDetails(localNoon(2026, 2, 24));
    expect(details).toHaveLength(1);
    expect(details[0].taskId).toBe("old-task");
  });
});
