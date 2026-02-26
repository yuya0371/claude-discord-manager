import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ScheduleStore } from "../src/scheduler/store.js";
import type { ScheduleJob } from "@claude-discord/common";

describe("ScheduleStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-store-test-"));
    filePath = path.join(tmpDir, "schedules.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Constructor / Load ---

  it("should initialize with empty jobs when file does not exist", () => {
    const store = new ScheduleStore(filePath);
    expect(store.getAll()).toEqual([]);
  });

  it("should load existing jobs from JSON file", () => {
    const existing: ScheduleJob[] = [
      {
        id: "sched-1",
        name: "Morning News",
        cronExpression: "0 8 * * *",
        prompt: "Fetch AI news",
        workerId: null,
        cwd: null,
        enabled: true,
        lastRunAt: null,
        lastTaskId: null,
        createdBy: "user-1",
      },
    ];
    fs.writeFileSync(filePath, JSON.stringify(existing), "utf-8");

    const store = new ScheduleStore(filePath);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getById("sched-1")).toEqual(existing[0]);
  });

  it("should handle corrupt JSON file gracefully", () => {
    fs.writeFileSync(filePath, "not valid json{{{", "utf-8");

    const store = new ScheduleStore(filePath);
    expect(store.getAll()).toEqual([]);
  });

  it("should set idCounter to max existing ID on load", () => {
    const existing: ScheduleJob[] = [
      {
        id: "sched-5",
        name: "Test",
        cronExpression: "* * * * *",
        prompt: "hello",
        workerId: null,
        cwd: null,
        enabled: true,
        lastRunAt: null,
        lastTaskId: null,
        createdBy: "user-1",
      },
    ];
    fs.writeFileSync(filePath, JSON.stringify(existing), "utf-8");

    const store = new ScheduleStore(filePath);
    expect(store.nextId()).toBe("sched-6");
  });

  // --- nextId() ---

  it("should generate sequential IDs", () => {
    const store = new ScheduleStore(filePath);
    expect(store.nextId()).toBe("sched-1");
    expect(store.nextId()).toBe("sched-2");
    expect(store.nextId()).toBe("sched-3");
  });

  // --- add() ---

  it("should add a job and persist to file", () => {
    const store = new ScheduleStore(filePath);
    const job: ScheduleJob = {
      id: store.nextId(),
      name: "Test Job",
      cronExpression: "0 9 * * *",
      prompt: "Do something",
      workerId: null,
      cwd: null,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    };
    store.add(job);

    expect(store.getAll()).toHaveLength(1);
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Test Job");
  });

  // --- remove() ---

  it("should remove an existing job and return true", () => {
    const store = new ScheduleStore(filePath);
    const job: ScheduleJob = {
      id: "sched-1",
      name: "Test",
      cronExpression: "* * * * *",
      prompt: "hello",
      workerId: null,
      cwd: null,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    };
    store.add(job);

    expect(store.remove("sched-1")).toBe(true);
    expect(store.getAll()).toHaveLength(0);
  });

  it("should return false for non-existent job", () => {
    const store = new ScheduleStore(filePath);
    expect(store.remove("sched-999")).toBe(false);
  });

  // --- update() ---

  it("should update a job partially", () => {
    const store = new ScheduleStore(filePath);
    const job: ScheduleJob = {
      id: "sched-1",
      name: "Test",
      cronExpression: "* * * * *",
      prompt: "hello",
      workerId: null,
      cwd: null,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    };
    store.add(job);

    const updated = store.update("sched-1", {
      enabled: false,
      lastRunAt: 1234567890,
    });

    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(updated!.lastRunAt).toBe(1234567890);
    expect(updated!.name).toBe("Test"); // unchanged
    expect(updated!.id).toBe("sched-1"); // id should not change
  });

  it("should return null when updating non-existent job", () => {
    const store = new ScheduleStore(filePath);
    const result = store.update("sched-999", { enabled: false });
    expect(result).toBeNull();
  });

  // --- getByName() ---

  it("should find job by name", () => {
    const store = new ScheduleStore(filePath);
    const job: ScheduleJob = {
      id: "sched-1",
      name: "Morning News",
      cronExpression: "0 8 * * *",
      prompt: "Fetch news",
      workerId: null,
      cwd: null,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    };
    store.add(job);

    expect(store.getByName("Morning News")).toEqual(job);
    expect(store.getByName("nonexistent")).toBeUndefined();
  });

  // --- Persistence round-trip ---

  it("should persist and reload jobs across instances", () => {
    const store1 = new ScheduleStore(filePath);
    const job: ScheduleJob = {
      id: store1.nextId(),
      name: "Test",
      cronExpression: "0 8 * * *",
      prompt: "hello",
      workerId: "worker-1",
      cwd: "/home/user",
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    };
    store1.add(job);

    const store2 = new ScheduleStore(filePath);
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getByName("Test")?.workerId).toBe("worker-1");
  });
});
