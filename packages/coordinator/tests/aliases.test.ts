import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectAliasManager } from "../src/project/aliases.js";

describe("ProjectAliasManager", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alias-test-"));
    filePath = path.join(tmpDir, "aliases.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Constructor / Load ---

  it("should initialize with empty aliases when file does not exist", () => {
    const manager = new ProjectAliasManager(filePath);
    expect(manager.getAll()).toEqual([]);
  });

  it("should load existing aliases from JSON file", () => {
    const existing = [
      { alias: "myproject", path: "/home/user/projects/my", preferredWorker: null },
      { alias: "keiba", path: "/home/user/projects/keiba", preferredWorker: "worker-1" },
    ];
    fs.writeFileSync(filePath, JSON.stringify(existing), "utf-8");

    const manager = new ProjectAliasManager(filePath);
    expect(manager.getAll()).toHaveLength(2);
    expect(manager.get("myproject")).toEqual(existing[0]);
    expect(manager.get("keiba")).toEqual(existing[1]);
  });

  it("should handle corrupt JSON file gracefully", () => {
    fs.writeFileSync(filePath, "not valid json{{{", "utf-8");

    const manager = new ProjectAliasManager(filePath);
    expect(manager.getAll()).toEqual([]);
  });

  // --- add() ---

  it("should add a new alias without preferred worker", () => {
    const manager = new ProjectAliasManager(filePath);
    const result = manager.add("proj", "/path/to/proj");

    expect(result).toEqual({
      alias: "proj",
      path: "/path/to/proj",
      preferredWorker: null,
    });
    expect(manager.get("proj")).toEqual(result);
  });

  it("should add a new alias with preferred worker", () => {
    const manager = new ProjectAliasManager(filePath);
    const result = manager.add("keiba", "/home/keiba", "worker-2");

    expect(result).toEqual({
      alias: "keiba",
      path: "/home/keiba",
      preferredWorker: "worker-2",
    });
  });

  it("should update an existing alias", () => {
    const manager = new ProjectAliasManager(filePath);
    manager.add("proj", "/old/path");
    manager.add("proj", "/new/path", "worker-3");

    const entry = manager.get("proj");
    expect(entry?.path).toBe("/new/path");
    expect(entry?.preferredWorker).toBe("worker-3");
  });

  it("should persist alias to JSON file on add", () => {
    const manager = new ProjectAliasManager(filePath);
    manager.add("test", "/path/test");

    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data).toEqual([
      { alias: "test", path: "/path/test", preferredWorker: null },
    ]);
  });

  it("should create parent directories when saving", () => {
    const deepPath = path.join(tmpDir, "nested", "deep", "aliases.json");
    const manager = new ProjectAliasManager(deepPath);
    manager.add("proj", "/path");

    expect(fs.existsSync(deepPath)).toBe(true);
  });

  // --- remove() ---

  it("should remove an existing alias and return true", () => {
    const manager = new ProjectAliasManager(filePath);
    manager.add("proj", "/path");

    const removed = manager.remove("proj");
    expect(removed).toBe(true);
    expect(manager.get("proj")).toBeUndefined();
  });

  it("should return false when removing non-existent alias", () => {
    const manager = new ProjectAliasManager(filePath);
    const removed = manager.remove("nonexistent");
    expect(removed).toBe(false);
  });

  it("should persist removal to JSON file", () => {
    const manager = new ProjectAliasManager(filePath);
    manager.add("a", "/path/a");
    manager.add("b", "/path/b");
    manager.remove("a");

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].alias).toBe("b");
  });

  // --- get() ---

  it("should return undefined for non-existent alias", () => {
    const manager = new ProjectAliasManager(filePath);
    expect(manager.get("nope")).toBeUndefined();
  });

  // --- getAll() ---

  it("should return all aliases", () => {
    const manager = new ProjectAliasManager(filePath);
    manager.add("a", "/path/a");
    manager.add("b", "/path/b");
    manager.add("c", "/path/c");

    const all = manager.getAll();
    expect(all).toHaveLength(3);
    const names = all.map((a) => a.alias).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  // --- resolve() ---

  describe("resolve()", () => {
    it("should return resolvedPath for non-alias directory (no @ prefix)", () => {
      const manager = new ProjectAliasManager(filePath);
      const result = manager.resolve("/some/path");

      expect(result).toEqual({
        resolvedPath: "/some/path",
        preferredWorker: null,
      });
    });

    it("should resolve @alias to the registered path", () => {
      const manager = new ProjectAliasManager(filePath);
      manager.add("keiba", "/home/user/keiba");

      const result = manager.resolve("@keiba");
      expect(result).toEqual({
        resolvedPath: "/home/user/keiba",
        preferredWorker: null,
      });
    });

    it("should resolve @alias with preferredWorker", () => {
      const manager = new ProjectAliasManager(filePath);
      manager.add("proj", "/home/proj", "worker-1");

      const result = manager.resolve("@proj");
      expect(result).toEqual({
        resolvedPath: "/home/proj",
        preferredWorker: "worker-1",
      });
    });

    it("should return null for unregistered @alias", () => {
      const manager = new ProjectAliasManager(filePath);
      const result = manager.resolve("@unknown");
      expect(result).toBeNull();
    });

    it("should handle empty string after @", () => {
      const manager = new ProjectAliasManager(filePath);
      const result = manager.resolve("@");
      expect(result).toBeNull();
    });
  });

  // --- Persistence round-trip ---

  it("should persist and reload aliases across instances", () => {
    const manager1 = new ProjectAliasManager(filePath);
    manager1.add("alpha", "/path/alpha", "w1");
    manager1.add("beta", "/path/beta");

    // New instance reads the same file
    const manager2 = new ProjectAliasManager(filePath);
    expect(manager2.getAll()).toHaveLength(2);
    expect(manager2.get("alpha")?.preferredWorker).toBe("w1");
    expect(manager2.get("beta")?.path).toBe("/path/beta");
  });

  it("should reflect removes across instances", () => {
    const manager1 = new ProjectAliasManager(filePath);
    manager1.add("a", "/a");
    manager1.add("b", "/b");
    manager1.remove("a");

    const manager2 = new ProjectAliasManager(filePath);
    expect(manager2.getAll()).toHaveLength(1);
    expect(manager2.get("a")).toBeUndefined();
    expect(manager2.get("b")).toBeDefined();
  });
});
