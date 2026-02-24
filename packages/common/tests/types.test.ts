import { describe, it, expect } from "vitest";
import {
  TaskStatus,
  WorkerStatus,
  PermissionMode,
  NotifyLevel,
} from "../src/types.js";

describe("TaskStatus enum", () => {
  it("should have all expected values", () => {
    expect(TaskStatus.Queued).toBe("queued");
    expect(TaskStatus.Running).toBe("running");
    expect(TaskStatus.Completed).toBe("completed");
    expect(TaskStatus.Failed).toBe("failed");
    expect(TaskStatus.Cancelled).toBe("cancelled");
  });

  it("should have exactly 5 members", () => {
    const values = Object.values(TaskStatus);
    expect(values).toHaveLength(5);
  });
});

describe("WorkerStatus enum", () => {
  it("should have all expected values", () => {
    expect(WorkerStatus.Online).toBe("online");
    expect(WorkerStatus.Busy).toBe("busy");
    expect(WorkerStatus.Offline).toBe("offline");
  });

  it("should have exactly 3 members", () => {
    const values = Object.values(WorkerStatus);
    expect(values).toHaveLength(3);
  });
});

describe("PermissionMode enum", () => {
  it("should have all expected values", () => {
    expect(PermissionMode.AcceptEdits).toBe("acceptEdits");
    expect(PermissionMode.Auto).toBe("auto");
    expect(PermissionMode.Confirm).toBe("confirm");
  });

  it("should have exactly 3 members", () => {
    const values = Object.values(PermissionMode);
    expect(values).toHaveLength(3);
  });
});

describe("NotifyLevel enum", () => {
  it("should have all expected values", () => {
    expect(NotifyLevel.All).toBe("all");
    expect(NotifyLevel.Important).toBe("important");
    expect(NotifyLevel.None).toBe("none");
  });

  it("should have exactly 3 members", () => {
    const values = Object.values(NotifyLevel);
    expect(values).toHaveLength(3);
  });
});
