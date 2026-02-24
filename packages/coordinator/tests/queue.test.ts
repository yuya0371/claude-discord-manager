import { describe, it, expect, beforeEach } from "vitest";
import { TaskQueue } from "../src/task/queue.js";
import { TASK_MAX_QUEUE_SIZE } from "@claude-discord/common";

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  describe("enqueue", () => {
    it("should add a taskId to the queue and return true", () => {
      const result = queue.enqueue("task-1");
      expect(result).toBe(true);
      expect(queue.size).toBe(1);
    });

    it("should maintain FIFO order", () => {
      queue.enqueue("task-1");
      queue.enqueue("task-2");
      queue.enqueue("task-3");
      expect(queue.getAll()).toEqual(["task-1", "task-2", "task-3"]);
    });

    it("should return false when queue is full", () => {
      for (let i = 0; i < TASK_MAX_QUEUE_SIZE; i++) {
        expect(queue.enqueue(`task-${i}`)).toBe(true);
      }
      expect(queue.enqueue("overflow")).toBe(false);
      expect(queue.size).toBe(TASK_MAX_QUEUE_SIZE);
    });
  });

  describe("dequeue", () => {
    it("should return the first taskId and remove it", () => {
      queue.enqueue("task-1");
      queue.enqueue("task-2");
      const result = queue.dequeue();
      expect(result).toBe("task-1");
      expect(queue.size).toBe(1);
    });

    it("should return null when queue is empty", () => {
      expect(queue.dequeue()).toBeNull();
    });
  });

  describe("remove", () => {
    it("should remove a specific taskId and return true", () => {
      queue.enqueue("task-1");
      queue.enqueue("task-2");
      queue.enqueue("task-3");
      const result = queue.remove("task-2");
      expect(result).toBe(true);
      expect(queue.getAll()).toEqual(["task-1", "task-3"]);
    });

    it("should return false when taskId not found", () => {
      queue.enqueue("task-1");
      expect(queue.remove("task-999")).toBe(false);
    });
  });

  describe("getAll", () => {
    it("should return a copy of the queue array", () => {
      queue.enqueue("task-1");
      queue.enqueue("task-2");
      const all = queue.getAll();
      expect(all).toEqual(["task-1", "task-2"]);
      // Mutation of returned array should not affect internal queue
      all.push("task-injected");
      expect(queue.getAll()).toEqual(["task-1", "task-2"]);
    });

    it("should return empty array when queue is empty", () => {
      expect(queue.getAll()).toEqual([]);
    });
  });

  describe("isEmpty", () => {
    it("should return true for empty queue", () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it("should return false after enqueue", () => {
      queue.enqueue("task-1");
      expect(queue.isEmpty()).toBe(false);
    });

    it("should return true after all items dequeued", () => {
      queue.enqueue("task-1");
      queue.dequeue();
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe("size", () => {
    it("should return 0 for empty queue", () => {
      expect(queue.size).toBe(0);
    });

    it("should reflect enqueue and dequeue operations", () => {
      queue.enqueue("task-1");
      queue.enqueue("task-2");
      expect(queue.size).toBe(2);
      queue.dequeue();
      expect(queue.size).toBe(1);
      queue.remove("task-2");
      expect(queue.size).toBe(0);
    });
  });
});
