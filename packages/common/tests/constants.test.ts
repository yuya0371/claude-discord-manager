import { describe, it, expect } from "vitest";
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  TASK_DEFAULT_TIMEOUT_MS,
  TASK_MAX_QUEUE_SIZE,
  DISCORD_MESSAGE_MAX_LENGTH,
  DISCORD_EMBED_MAX_LENGTH,
  DISCORD_STATUS_UPDATE_INTERVAL_MS,
  FILE_MAX_SIZE_BYTES,
  PROTOCOL_VERSION,
} from "../src/constants.js";

describe("constants", () => {
  it("WS_HEARTBEAT_INTERVAL_MS should be 30 seconds", () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it("WS_RECONNECT_BASE_MS should be 1 second", () => {
    expect(WS_RECONNECT_BASE_MS).toBe(1_000);
  });

  it("WS_RECONNECT_MAX_MS should be 60 seconds", () => {
    expect(WS_RECONNECT_MAX_MS).toBe(60_000);
  });

  it("TASK_DEFAULT_TIMEOUT_MS should be 10 minutes", () => {
    expect(TASK_DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it("TASK_MAX_QUEUE_SIZE should be 50", () => {
    expect(TASK_MAX_QUEUE_SIZE).toBe(50);
  });

  it("DISCORD_MESSAGE_MAX_LENGTH should be 2000", () => {
    expect(DISCORD_MESSAGE_MAX_LENGTH).toBe(2000);
  });

  it("DISCORD_EMBED_MAX_LENGTH should be 4096", () => {
    expect(DISCORD_EMBED_MAX_LENGTH).toBe(4096);
  });

  it("DISCORD_STATUS_UPDATE_INTERVAL_MS should be 1 second", () => {
    expect(DISCORD_STATUS_UPDATE_INTERVAL_MS).toBe(1_000);
  });

  it("FILE_MAX_SIZE_BYTES should be 8MB", () => {
    expect(FILE_MAX_SIZE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("PROTOCOL_VERSION should be a valid semver string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROTOCOL_VERSION).toBe("1.0.0");
  });
});
