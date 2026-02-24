import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WorkerRegistry } from "../src/worker/registry.js";
import {
  WorkerStatus,
  PROTOCOL_VERSION,
  createMessage,
  type WsMessage,
  type WorkerRegisterPayload,
  type WorkerHeartbeatPayload,
} from "@claude-discord/common";

// WebSocket mock
function createMockWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
  } as unknown as import("ws").WebSocket;
}

function makeRegisterMsg(
  overrides: Partial<WorkerRegisterPayload> = {},
): WsMessage<WorkerRegisterPayload> {
  return createMessage<WorkerRegisterPayload>("worker:register", {
    name: "test-worker",
    secret: "correct-secret",
    os: "linux",
    nodeVersion: "v20.0.0",
    claudeCliVersion: "1.0.0",
    defaultCwd: "/home/user",
    allowedDirs: ["/home/user"],
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  });
}

describe("WorkerRegistry", () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new WorkerRegistry("correct-secret");
  });

  afterEach(() => {
    registry.destroy();
    vi.useRealTimers();
  });

  describe("handleRegister", () => {
    it("should register a worker with correct secret", () => {
      const ws = createMockWs();
      const msg = makeRegisterMsg();

      const result = registry.handleRegister(ws, msg);

      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledOnce();
      const ackStr = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const ack = JSON.parse(ackStr);
      expect(ack.payload.success).toBe(true);
      expect(ack.payload.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it("should reject worker with incorrect secret", () => {
      const ws = createMockWs();
      const msg = makeRegisterMsg({ secret: "wrong-secret" });

      const result = registry.handleRegister(ws, msg);

      expect(result).toBe(false);
      expect(ws.send).toHaveBeenCalledOnce();
      const ackStr = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const ack = JSON.parse(ackStr);
      expect(ack.payload.success).toBe(false);
      expect(ack.payload.error).toContain("Authentication failed");
      expect(ws.close).toHaveBeenCalledOnce();
    });

    it("should store worker info after registration", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      const worker = registry.getWorker("test-worker");
      expect(worker).toBeDefined();
      expect(worker!.name).toBe("test-worker");
      expect(worker!.status).toBe(WorkerStatus.Online);
      expect(worker!.os).toBe("linux");
    });
  });

  describe("handleHeartbeat", () => {
    it("should update lastHeartbeat and currentTaskId", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      const heartbeatMsg = createMessage<WorkerHeartbeatPayload>(
        "worker:heartbeat",
        { status: WorkerStatus.Busy, currentTaskId: "task-1" },
        { workerId: "test-worker" },
      );
      registry.handleHeartbeat("test-worker", heartbeatMsg);

      const worker = registry.getWorker("test-worker");
      expect(worker!.currentTaskId).toBe("task-1");
    });

    it("should send heartbeat ack", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());
      // Clear the registration send call
      (ws.send as ReturnType<typeof vi.fn>).mockClear();

      const heartbeatMsg = createMessage<WorkerHeartbeatPayload>(
        "worker:heartbeat",
        { status: WorkerStatus.Online, currentTaskId: null },
        { workerId: "test-worker" },
      );
      registry.handleHeartbeat("test-worker", heartbeatMsg);

      expect(ws.send).toHaveBeenCalledOnce();
      const ackStr = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const ack = JSON.parse(ackStr);
      expect(ack.type).toBe("worker:heartbeat_ack");
      expect(ack.payload.acknowledged).toBe(true);
    });

    it("should not throw for unknown workerId", () => {
      const heartbeatMsg = createMessage<WorkerHeartbeatPayload>(
        "worker:heartbeat",
        { status: WorkerStatus.Online, currentTaskId: null },
        { workerId: "unknown" },
      );
      expect(() => registry.handleHeartbeat("unknown", heartbeatMsg)).not.toThrow();
    });
  });

  describe("handleDisconnect", () => {
    it("should remove worker from registry", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      registry.handleDisconnect("test-worker");

      expect(registry.getWorker("test-worker")).toBeUndefined();
      expect(registry.getAllWorkers()).toHaveLength(0);
    });

    it("should call onWorkerDisconnected callback with running task info", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());
      registry.setWorkerCurrentTask("test-worker", "task-1");

      const callback = vi.fn();
      registry.onWorkerDisconnected = callback;

      registry.handleDisconnect("test-worker");

      expect(callback).toHaveBeenCalledWith("test-worker", true);
    });

    it("should call onWorkerDisconnected with false when no running task", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      const callback = vi.fn();
      registry.onWorkerDisconnected = callback;

      registry.handleDisconnect("test-worker");

      expect(callback).toHaveBeenCalledWith("test-worker", false);
    });

    it("should not throw for unknown workerId", () => {
      expect(() => registry.handleDisconnect("unknown")).not.toThrow();
    });
  });

  describe("getAvailableWorker", () => {
    it("should return null when no workers are registered", () => {
      expect(registry.getAvailableWorker()).toBeNull();
    });

    it("should return an online worker", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      const worker = registry.getAvailableWorker();
      expect(worker).toBeDefined();
      expect(worker!.id).toBe("test-worker");
    });

    it("should not return busy workers", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());
      registry.setWorkerStatus("test-worker", WorkerStatus.Busy);

      const worker = registry.getAvailableWorker();
      expect(worker).toBeNull();
    });

    it("should return preferred worker when specified and available", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.handleRegister(ws1, makeRegisterMsg({ name: "worker-1" }));
      registry.handleRegister(ws2, makeRegisterMsg({ name: "worker-2" }));

      const worker = registry.getAvailableWorker("worker-2");
      expect(worker!.id).toBe("worker-2");
    });

    it("should fallback to round-robin when preferred worker is not available", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.handleRegister(ws1, makeRegisterMsg({ name: "worker-1" }));
      registry.handleRegister(ws2, makeRegisterMsg({ name: "worker-2" }));
      registry.setWorkerStatus("worker-2", WorkerStatus.Busy);

      const worker = registry.getAvailableWorker("worker-2");
      expect(worker!.id).toBe("worker-1");
    });

    it("should round-robin across available workers", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.handleRegister(ws1, makeRegisterMsg({ name: "worker-1" }));
      registry.handleRegister(ws2, makeRegisterMsg({ name: "worker-2" }));

      const first = registry.getAvailableWorker();
      const second = registry.getAvailableWorker();
      // Should get different workers (round-robin)
      expect(first!.id).not.toBe(second!.id);
    });
  });

  describe("setWorkerStatus / setWorkerCurrentTask", () => {
    it("should update worker status", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      registry.setWorkerStatus("test-worker", WorkerStatus.Busy);
      expect(registry.getWorker("test-worker")!.status).toBe(WorkerStatus.Busy);
    });

    it("should update currentTaskId", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      registry.setWorkerCurrentTask("test-worker", "task-42");
      expect(registry.getWorker("test-worker")!.currentTaskId).toBe("task-42");

      registry.setWorkerCurrentTask("test-worker", null);
      expect(registry.getWorker("test-worker")!.currentTaskId).toBeNull();
    });
  });

  describe("getWorkerIdByWs", () => {
    it("should return workerId for known ws connection", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      expect(registry.getWorkerIdByWs(ws)).toBe("test-worker");
    });

    it("should return null for unknown ws connection", () => {
      const ws = createMockWs();
      expect(registry.getWorkerIdByWs(ws)).toBeNull();
    });
  });

  describe("preferredWorker", () => {
    it("should set and get preferred worker for a user", () => {
      registry.setPreferredWorker("user-1", "worker-1");
      expect(registry.getPreferredWorkerId("user-1")).toBe("worker-1");
    });

    it("should remove preferred worker when set to null", () => {
      registry.setPreferredWorker("user-1", "worker-1");
      registry.setPreferredWorker("user-1", null);
      expect(registry.getPreferredWorkerId("user-1")).toBeNull();
    });

    it("should return null for user without preference", () => {
      expect(registry.getPreferredWorkerId("user-1")).toBeNull();
    });
  });

  describe("heartbeat timeout", () => {
    it("should disconnect worker after heartbeat timeout", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      expect(registry.getWorker("test-worker")).toBeDefined();

      // Advance time past 2x heartbeat interval (timeout threshold)
      vi.advanceTimersByTime(60_001);

      expect(registry.getWorker("test-worker")).toBeUndefined();
    });
  });

  describe("destroy", () => {
    it("should clear all workers and connections", () => {
      const ws = createMockWs();
      registry.handleRegister(ws, makeRegisterMsg());

      registry.destroy();

      expect(registry.getAllWorkers()).toHaveLength(0);
      expect(ws.close).toHaveBeenCalled();
    });
  });
});
