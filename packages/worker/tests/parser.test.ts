import { describe, it, expect, beforeEach } from "vitest";
import { StreamJsonParser } from "../src/claude/parser.js";

describe("StreamJsonParser", () => {
  let parser: StreamJsonParser;

  beforeEach(() => {
    parser = new StreamJsonParser();
  });

  describe("parse - basic line handling", () => {
    it("should parse a complete JSON line", () => {
      const events = parser.parse('{"type":"result","result":"hello","session_id":"s1"}\n');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("result");
    });

    it("should handle multiple lines in one chunk", () => {
      const chunk =
        '{"type":"result","result":"a","session_id":null}\n' +
        '{"type":"result","result":"b","session_id":null}\n';
      const events = parser.parse(chunk);
      expect(events).toHaveLength(2);
    });

    it("should buffer incomplete lines across chunks", () => {
      const events1 = parser.parse('{"type":"result","res');
      expect(events1).toHaveLength(0);

      const events2 = parser.parse('ult":"hello","session_id":null}\n');
      expect(events2).toHaveLength(1);
      expect(events2[0].eventType).toBe("result");
    });

    it("should skip empty lines", () => {
      const events = parser.parse('\n\n{"type":"result","result":"ok","session_id":null}\n\n');
      expect(events).toHaveLength(1);
    });

    it("should skip invalid JSON lines without throwing", () => {
      const events = parser.parse('not valid json\n{"type":"result","result":"ok","session_id":null}\n');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("result");
    });
  });

  describe("parse - assistant message", () => {
    it("should classify assistant message with text content", () => {
      const json = {
        type: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("assistant_message");
      expect(events[0].data).toEqual({ text: "Hello world" });
    });

    it("should skip assistant message without text content", () => {
      const json = {
        type: "assistant",
        content: [{ type: "image", url: "http://example.com/img.png" }],
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(0);
    });

    it("should skip assistant message with empty content", () => {
      const json = { type: "assistant", content: [] };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(0);
    });
  });

  describe("parse - tool_use", () => {
    it("should classify tool_use event with Read tool", () => {
      const json = {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/tmp/test.ts" },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("tool_use_begin");
      expect(events[0].data).toEqual({
        toolName: "Read",
        summary: "Read: /tmp/test.ts",
      });
    });

    it("should classify tool_use event with Bash tool", () => {
      const json = {
        type: "tool_use",
        name: "Bash",
        input: { command: "npm test --verbose" },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        toolName: "Bash",
        summary: "Bash: npm test --verbose",
      });
    });

    it("should classify tool_use event with Grep tool", () => {
      const json = {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "TODO", path: "/src" },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        toolName: "Grep",
        summary: 'Grep: "TODO" /src',
      });
    });

    it("should use toolName as summary for unknown tools", () => {
      const json = {
        type: "tool_use",
        name: "CustomTool",
        input: { foo: "bar" },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        toolName: "CustomTool",
        summary: "CustomTool",
      });
    });

    it("should truncate long Bash commands to 60 chars", () => {
      const longCmd = "a".repeat(100);
      const json = {
        type: "tool_use",
        name: "Bash",
        input: { command: longCmd },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      const data = events[0].data as { toolName: string; summary: string };
      expect(data.summary).toBe(`Bash: ${"a".repeat(60)}`);
    });
  });

  describe("parse - tool_result", () => {
    it("should classify tool_result as tool_use_end with success", () => {
      const json = {
        type: "tool_result",
        tool_name: "Read",
        content: "file contents here",
        is_error: false,
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("tool_use_end");
      expect(events[0].data).toEqual({
        toolName: "Read",
        summary: "Read: file contents here",
        success: true,
      });
    });

    it("should classify tool_result with is_error as failure", () => {
      const json = {
        type: "tool_result",
        tool_name: "Bash",
        content: "command not found",
        is_error: true,
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        toolName: "Bash",
        summary: "Bash: error",
        success: false,
      });
    });

    it("should fallback to 'name' field if 'tool_name' is absent", () => {
      const json = {
        type: "tool_result",
        name: "Edit",
        content: "ok",
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      const data = events[0].data as { toolName: string };
      expect(data.toolName).toBe("Edit");
    });

    it("should fallback to 'unknown' if neither tool_name nor name exists", () => {
      const json = {
        type: "tool_result",
        content: "ok",
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      const data = events[0].data as { toolName: string };
      expect(data.toolName).toBe("unknown");
    });
  });

  describe("parse - result", () => {
    it("should classify result event", () => {
      const json = {
        type: "result",
        result: "Final answer here",
        session_id: "session-abc",
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("result");
      expect(events[0].data).toEqual({
        text: "Final answer here",
        sessionId: "session-abc",
      });
    });

    it("should handle null session_id", () => {
      const json = {
        type: "result",
        result: "done",
        session_id: null,
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ text: "done", sessionId: null });
    });
  });

  describe("parse - token_usage", () => {
    it("should classify events with usage field as token_usage", () => {
      const json = {
        type: "something_with_usage",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("token_usage");
      expect(events[0].data).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      });
    });

    it("should default missing usage fields to 0", () => {
      const json = {
        type: "usage_only",
        usage: {
          input_tokens: 42,
        },
      };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        inputTokens: 42,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  describe("parse - unknown events", () => {
    it("should return null for unknown event types without usage", () => {
      const json = { type: "something_unknown", data: {} };
      const events = parser.parse(JSON.stringify(json) + "\n");
      expect(events).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("should clear the internal buffer", () => {
      // Feed incomplete line
      parser.parse('{"type":"result","res');
      parser.reset();
      // After reset, previous buffer should be gone
      const events = parser.parse('ult":"hello","session_id":null}\n');
      // This will try to parse 'ult":"hello","session_id":null}' which is invalid
      expect(events).toHaveLength(0);
    });
  });
});
