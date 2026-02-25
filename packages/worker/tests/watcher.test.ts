import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TeamWatcher } from "../src/team/watcher.js";

describe("TeamWatcher", () => {
  let tmpDir: string;
  let watcher: TeamWatcher;
  let originalHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamwatcher-test-"));
    // os.homedir() をモックして、tmpDir を ~/.claude のベースにする
    originalHomedir = os.homedir;
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

    watcher = new TeamWatcher("test-worker");
  });

  afterEach(() => {
    watcher.stop();
    os.homedir = originalHomedir;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Constructor ---

  it("should initialize with empty active teams", () => {
    expect(watcher.getActiveTeams()).toEqual([]);
  });

  // --- start() without projects dir ---

  it("should not throw when ~/.claude/projects does not exist", () => {
    expect(() => watcher.start()).not.toThrow();
    expect(watcher.getActiveTeams()).toEqual([]);
  });

  // --- start() with empty projects dir ---

  it("should handle empty projects directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude", "projects"), { recursive: true });
    expect(() => watcher.start()).not.toThrow();
    expect(watcher.getActiveTeams()).toEqual([]);
  });

  // --- scanForTeams via JSONL parsing ---

  it("should detect team from session log with SendMessage and TaskCreate", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "my-project");
    fs.mkdirSync(projectsDir, { recursive: true });

    // Create a session log with team activity
    const sessionLog = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "TaskCreate",
        input: { subject: "Implement feature X", owner: "dev-1" },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: {
          type: "message",
          recipient: "dev-1",
          content: "Please work on feature X",
          summary: "Assigning feature X",
        },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "TaskUpdate",
        input: { taskId: "t-1", status: "in_progress", owner: "dev-1" },
        timestamp: Date.now(),
      }),
    ].join("\n");

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");
    // Touch the file to ensure it's recent
    fs.utimesSync(logFile, new Date(), new Date());

    watcher.start();

    const teams = watcher.getActiveTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].teamName).toBe("my-project");
    expect(teams[0].workerId).toBe("test-worker");
    expect(teams[0].members).toHaveLength(1);
    expect(teams[0].members[0].name).toBe("dev-1");
    expect(teams[0].tasks).toHaveLength(1);
    expect(teams[0].tasks[0].subject).toBe("Implement feature X");
    expect(teams[0].tasks[0].status).toBe("in_progress");
    expect(teams[0].recentMessages).toHaveLength(1);
  });

  it("should ignore JSONL files older than 1 hour", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "old-project");
    fs.mkdirSync(projectsDir, { recursive: true });

    const sessionLog = JSON.stringify({
      type: "tool_use",
      tool_name: "TaskCreate",
      input: { subject: "Old task" },
      timestamp: Date.now(),
    });

    const logFile = path.join(projectsDir, "old-session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");
    // Set file mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(logFile, twoHoursAgo, twoHoursAgo);

    watcher.start();
    expect(watcher.getActiveTeams()).toEqual([]);
  });

  it("should ignore files without team activity (no TaskCreate or SendMessage)", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "solo-project");
    fs.mkdirSync(projectsDir, { recursive: true });

    const sessionLog = JSON.stringify({
      type: "tool_use",
      tool_name: "Read",
      input: { file_path: "/some/file.ts" },
    });

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");

    watcher.start();
    expect(watcher.getActiveTeams()).toEqual([]);
  });

  it("should handle corrupt JSONL lines gracefully", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "mixed-project");
    fs.mkdirSync(projectsDir, { recursive: true });

    const sessionLog = [
      "not valid json",
      JSON.stringify({
        type: "tool_use",
        tool_name: "TaskCreate",
        input: { subject: "Valid task" },
        timestamp: Date.now(),
      }),
      "another bad line{{{",
      JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: { type: "message", recipient: "worker-a", content: "Hello", summary: "Hi" },
        timestamp: Date.now(),
      }),
    ].join("\n");

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");

    watcher.start();
    const teams = watcher.getActiveTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].tasks).toHaveLength(1);
    expect(teams[0].members).toHaveLength(1);
  });

  it("should detect multiple team members from SendMessage recipients", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "multi-member");
    fs.mkdirSync(projectsDir, { recursive: true });

    const sessionLog = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "TaskCreate",
        input: { subject: "Task 1" },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: { type: "message", recipient: "alice", content: "msg1", summary: "s1" },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: { type: "message", recipient: "bob", content: "msg2", summary: "s2" },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: { type: "message", recipient: "alice", content: "msg3", summary: "s3" },
        timestamp: Date.now(),
      }),
    ].join("\n");

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");

    watcher.start();
    const teams = watcher.getActiveTeams();
    expect(teams).toHaveLength(1);
    // alice should not be duplicated
    expect(teams[0].members).toHaveLength(2);
    const names = teams[0].members.map((m) => m.name).sort();
    expect(names).toEqual(["alice", "bob"]);
    // 3 messages total
    expect(teams[0].recentMessages).toHaveLength(3);
  });

  // --- stop() ---

  it("should stop watchers and clear debounce timer", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    watcher.start();
    expect(() => watcher.stop()).not.toThrow();
  });

  // --- EventEmitter ---

  it("should emit 'update' event when team info changes", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "event-project");
    fs.mkdirSync(projectsDir, { recursive: true });

    const sessionLog = JSON.stringify({
      type: "tool_use",
      tool_name: "TaskCreate",
      input: { subject: "New task" },
      timestamp: Date.now(),
    }) + "\n" + JSON.stringify({
      type: "tool_use",
      tool_name: "SendMessage",
      input: { type: "message", recipient: "teammate", content: "hi", summary: "greeting" },
      timestamp: Date.now(),
    });

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, sessionLog, "utf-8");

    const updateHandler = vi.fn();
    watcher.on("update", updateHandler);

    watcher.start();

    expect(updateHandler).toHaveBeenCalledTimes(1);
    expect(updateHandler.mock.calls[0][0].teamName).toBe("event-project");
  });

  // --- MAX_RECENT_MESSAGES ---

  it("should limit recent messages to 20", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "many-msgs");
    fs.mkdirSync(projectsDir, { recursive: true });

    const lines: string[] = [];
    // TaskCreate to activate team mode
    lines.push(JSON.stringify({
      type: "tool_use",
      tool_name: "TaskCreate",
      input: { subject: "Lots of messages" },
      timestamp: Date.now(),
    }));
    // 25 SendMessage entries
    for (let i = 0; i < 25; i++) {
      lines.push(JSON.stringify({
        type: "tool_use",
        tool_name: "SendMessage",
        input: {
          type: "message",
          recipient: "teammate",
          content: `Message ${i}`,
          summary: `msg ${i}`,
        },
        timestamp: Date.now() + i,
      }));
    }

    const logFile = path.join(projectsDir, "session.jsonl");
    fs.writeFileSync(logFile, lines.join("\n"), "utf-8");

    watcher.start();
    const teams = watcher.getActiveTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].recentMessages).toHaveLength(20);
    // Should keep the most recent 20 (last 20)
    expect(teams[0].recentMessages[0].summary).toBe("msg 5");
    expect(teams[0].recentMessages[19].summary).toBe("msg 24");
  });
});
