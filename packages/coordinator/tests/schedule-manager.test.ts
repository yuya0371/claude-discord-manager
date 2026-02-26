import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ScheduleStore } from "../src/scheduler/store.js";
import { ScheduleManager } from "../src/scheduler/manager.js";
import { TaskManager } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import { WorkerRegistry } from "../src/worker/registry.js";

describe("ScheduleManager", () => {
  let tmpDir: string;
  let filePath: string;
  let store: ScheduleStore;
  let taskManager: TaskManager;
  let manager: ScheduleManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-mgr-test-"));
    filePath = path.join(tmpDir, "schedules.json");
    store = new ScheduleStore(filePath);

    const queue = new TaskQueue();
    const registry = new WorkerRegistry("test-secret");
    taskManager = new TaskManager(queue, registry);
    manager = new ScheduleManager(store, taskManager);
  });

  afterEach(() => {
    manager.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- addJob() ---

  it("should add a job successfully", () => {
    const job = manager.addJob(
      "Test Job",
      "0 8 * * *",
      "Hello {{date}}",
      "user-1"
    );

    expect(job.name).toBe("Test Job");
    expect(job.cronExpression).toBe("0 8 * * *");
    expect(job.prompt).toBe("Hello {{date}}");
    expect(job.enabled).toBe(true);
    expect(job.id).toMatch(/^sched-\d+$/);
  });

  it("should throw on invalid cron expression", () => {
    expect(() =>
      manager.addJob("Bad", "invalid cron", "prompt", "user-1")
    ).toThrow("Invalid cron expression");
  });

  it("should throw on duplicate name", () => {
    manager.addJob("Test", "0 8 * * *", "prompt", "user-1");
    expect(() =>
      manager.addJob("Test", "0 9 * * *", "prompt2", "user-1")
    ).toThrow('Schedule "Test" already exists');
  });

  it("should add a job with worker and cwd", () => {
    const job = manager.addJob(
      "WithWorker",
      "0 8 * * *",
      "prompt",
      "user-1",
      "worker-1",
      "/home/user"
    );

    expect(job.workerId).toBe("worker-1");
    expect(job.cwd).toBe("/home/user");
  });

  // --- removeJob() ---

  it("should remove an existing job", () => {
    manager.addJob("ToRemove", "0 8 * * *", "prompt", "user-1");
    expect(manager.removeJob("ToRemove")).toBe(true);
    expect(manager.getByName("ToRemove")).toBeUndefined();
  });

  it("should return false for non-existent job", () => {
    expect(manager.removeJob("nonexistent")).toBe(false);
  });

  // --- toggleJob() ---

  it("should toggle job enabled/disabled", () => {
    manager.addJob("Toggle", "0 8 * * *", "prompt", "user-1");

    const disabled = manager.toggleJob("Toggle");
    expect(disabled?.enabled).toBe(false);

    const enabled = manager.toggleJob("Toggle");
    expect(enabled?.enabled).toBe(true);
  });

  it("should return null for non-existent job", () => {
    expect(manager.toggleJob("nonexistent")).toBeNull();
  });

  // --- executeJob() ---

  it("should create a task via TaskManager", async () => {
    const job = manager.addJob(
      "Execute",
      "0 8 * * *",
      "Run this task",
      "user-1"
    );

    const taskId = await manager.executeJob(job);
    expect(taskId).toMatch(/^task-\d+$/);

    // Task should be created in TaskManager
    const task = taskManager.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.prompt).toBe("Run this task");
    expect(task!.requestedBy).toBe("scheduler:Execute");
    expect(task!.permissionMode).toBe("auto");
  });

  it("should update lastRunAt and lastTaskId after execution", async () => {
    const job = manager.addJob(
      "RunUpdate",
      "0 8 * * *",
      "prompt",
      "user-1"
    );

    await manager.executeJob(job);

    const updated = manager.getByName("RunUpdate");
    expect(updated?.lastRunAt).not.toBeNull();
    expect(updated?.lastTaskId).toMatch(/^task-\d+$/);
  });

  it("should call onJobExecuted callback", async () => {
    const callback = vi.fn();
    manager.onJobExecuted = callback;

    const job = manager.addJob("Callback", "0 8 * * *", "prompt", "user-1");
    await manager.executeJob(job);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Callback" }),
      expect.stringMatching(/^task-\d+$/)
    );
  });

  // --- runNow() ---

  it("should execute job by name", async () => {
    manager.addJob("RunNow", "0 8 * * *", "prompt", "user-1");
    const taskId = await manager.runNow("RunNow");
    expect(taskId).toMatch(/^task-\d+$/);
  });

  it("should throw for non-existent job name", async () => {
    await expect(manager.runNow("nonexistent")).rejects.toThrow(
      'Schedule "nonexistent" not found'
    );
  });

  // --- replaceTemplateVars() ---

  describe("replaceTemplateVars()", () => {
    it("should replace {{date}}", () => {
      const now = new Date(2026, 1, 26); // Feb 26, 2026
      const result = manager.replaceTemplateVars("Today is {{date}}", now);
      expect(result).toBe("Today is 2026-02-26");
    });

    it("should replace {{datetime}}", () => {
      const now = new Date(2026, 1, 26, 8, 30);
      const result = manager.replaceTemplateVars("Now: {{datetime}}", now);
      expect(result).toBe("Now: 2026-02-26 08:30");
    });

    it("should replace {{weekday}}", () => {
      const now = new Date(2026, 1, 26); // Thursday
      const result = manager.replaceTemplateVars("{{weekday}}です", now);
      expect(result).toBe("木曜日です");
    });

    it("should replace multiple variables", () => {
      const now = new Date(2026, 1, 26, 8, 0);
      const result = manager.replaceTemplateVars(
        "{{date}} ({{weekday}}) {{datetime}}",
        now
      );
      expect(result).toBe("2026-02-26 (木曜日) 2026-02-26 08:00");
    });

    it("should handle text without variables", () => {
      const result = manager.replaceTemplateVars("No variables here");
      expect(result).toBe("No variables here");
    });

    it("should replace multiple occurrences of same variable", () => {
      const now = new Date(2026, 1, 26);
      const result = manager.replaceTemplateVars(
        "{{date}} and {{date}}",
        now
      );
      expect(result).toBe("2026-02-26 and 2026-02-26");
    });
  });

  // --- getAll() ---

  it("should return all jobs", () => {
    manager.addJob("A", "0 1 * * *", "p1", "user-1");
    manager.addJob("B", "0 2 * * *", "p2", "user-1");
    manager.addJob("C", "0 3 * * *", "p3", "user-1");

    expect(manager.getAll()).toHaveLength(3);
  });

  // --- loadAll() ---

  it("should load and register enabled jobs", () => {
    // Pre-populate store
    store.add({
      id: "sched-1",
      name: "Enabled",
      cronExpression: "0 8 * * *",
      prompt: "hello",
      workerId: null,
      cwd: null,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    });
    store.add({
      id: "sched-2",
      name: "Disabled",
      cronExpression: "0 9 * * *",
      prompt: "world",
      workerId: null,
      cwd: null,
      enabled: false,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: "user-1",
    });

    // Create new manager and load
    const newManager = new ScheduleManager(store, taskManager);
    newManager.loadAll();

    expect(newManager.getAll()).toHaveLength(2);

    newManager.destroy();
  });
});
