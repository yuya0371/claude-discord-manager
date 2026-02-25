/**
 * 単体テスト: embeds.ts のユーティリティ関数
 *
 * - splitTextForDiscord: 長文テキストの分割
 * - isLongResult: 長文判定
 */
import { describe, it, expect } from "vitest";
import { splitTextForDiscord, isLongResult } from "../src/discord/embeds.js";
import { DISCORD_MESSAGE_MAX_LENGTH } from "@claude-discord/common";

describe("isLongResult", () => {
  it("should return false for null", () => {
    expect(isLongResult(null)).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isLongResult("")).toBe(false);
  });

  it("should return false for short text", () => {
    expect(isLongResult("Hello world")).toBe(false);
  });

  it("should return false for text exactly at threshold", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH);
    expect(isLongResult(text)).toBe(false);
  });

  it("should return true for text exceeding threshold", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH + 1);
    expect(isLongResult(text)).toBe(true);
  });
});

describe("splitTextForDiscord", () => {
  it("should return single chunk for short text", () => {
    const text = "Hello world";
    const chunks = splitTextForDiscord(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("should return single chunk for text exactly at max length", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH);
    const chunks = splitTextForDiscord(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("should split text exceeding max length into multiple chunks", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH * 2 + 100);
    const chunks = splitTextForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    // 再結合すると元のテキストと一致する
    expect(chunks.join("")).toBe(text);
  });

  it("should prefer splitting at newlines", () => {
    // 行1はmaxLen - 10文字、行2は100文字
    const line1 = "x".repeat(DISCORD_MESSAGE_MAX_LENGTH - 10);
    const line2 = "y".repeat(100);
    const text = line1 + "\n" + line2;
    const chunks = splitTextForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("should handle text with no newlines by splitting at max length", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH + 500);
    const chunks = splitTextForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_MAX_LENGTH);
    expect(chunks[1]).toHaveLength(500);
  });

  it("should not produce chunks exceeding max length", () => {
    const text = "a".repeat(DISCORD_MESSAGE_MAX_LENGTH * 5);
    const chunks = splitTextForDiscord(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_LENGTH);
    }
  });

  it("should handle empty string", () => {
    const chunks = splitTextForDiscord("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("");
  });
});
