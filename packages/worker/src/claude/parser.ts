// packages/worker/src/claude/parser.ts

import type { StreamEventType, StreamEventData } from "@claude-discord/common";

export interface ParsedEvent {
  eventType: StreamEventType;
  data: StreamEventData;
}

/**
 * Claude CLI の stream-json 出力をパースする。
 * stdout の chunk を受け取り、行単位で JSON パースしてイベントに分類する。
 */
export class StreamJsonParser {
  private buffer = "";

  /**
   * stdout の chunk を受け取り、完全な行単位でパースする。
   * 不完全な行はバッファに保持する。
   */
  parse(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // 最後の不完全な行はバッファに残す
    this.buffer = lines.pop() ?? "";

    const events: ParsedEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        const event = this.classifyEvent(json);
        if (event) events.push(event);
      } catch {
        console.warn("[Parser] Failed to parse stream-json line:", trimmed.substring(0, 120));
      }
    }
    return events;
  }

  /** バッファをリセットする */
  reset(): void {
    this.buffer = "";
  }

  /**
   * パースした JSON オブジェクトをイベント種別に分類する。
   */
  private classifyEvent(json: Record<string, unknown>): ParsedEvent | null {
    const type = json.type as string | undefined;

    switch (type) {
      case "assistant": {
        const content = json.content as Array<{ type: string; text?: string }> | undefined;
        const textBlock = content?.find((c) => c.type === "text");
        if (textBlock?.text) {
          return {
            eventType: "assistant_message",
            data: { text: textBlock.text },
          };
        }
        break;
      }

      case "tool_use": {
        const toolName = json.name as string;
        const input = (json.input as Record<string, unknown>) ?? {};
        const summary = this.buildToolSummary(toolName, input);
        return {
          eventType: "tool_use_begin",
          data: { toolName, summary },
        };
      }

      // Claude CLI が AskUserQuestion を呼び出した場合（ユーザーへの質問）
      // stream-json では type: "tool_use" で name: "AskUserQuestion" として出力されるが、
      // 別のフォーマットで出力される可能性にも対応
      case "ask_user": {
        const question = (json.question as string) ?? (json.text as string) ?? "";
        const options = (json.options as string[]) ?? null;
        return {
          eventType: "tool_use_begin",
          data: { toolName: "AskUserQuestion", summary: `Question: ${question.substring(0, 80)}` },
        };
      }

      case "tool_result": {
        const toolName = ((json.tool_name ?? json.name ?? "unknown") as string);
        const isError = json.is_error as boolean | undefined;
        const content = (json.content as string) ?? "";
        const summary = this.buildToolResultSummary(toolName, content, !!isError);
        return {
          eventType: "tool_use_end",
          data: { toolName, summary, success: !isError },
        };
      }

      case "result": {
        const resultContent = (json.result as string) ?? "";
        const sessionId = (json.session_id as string) ?? null;
        return {
          eventType: "result",
          data: { text: resultContent, sessionId },
        };
      }

      default:
        break;
    }

    // トークン使用量(usage フィールドがあればどのイベントでも抽出)
    if (json.usage) {
      const usage = json.usage as Record<string, number>;
      return {
        eventType: "token_usage",
        data: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
      };
    }

    return null;
  }

  /** ツール呼び出しの概要文字列を生成 */
  private buildToolSummary(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Read":
        return `Read: ${input.file_path ?? "unknown"}`;
      case "Edit":
        return `Edit: ${input.file_path ?? "unknown"}`;
      case "Write":
        return `Write: ${input.file_path ?? "unknown"}`;
      case "Bash":
        return `Bash: ${((input.command as string) ?? "unknown").substring(0, 60)}`;
      case "Grep":
        return `Grep: "${input.pattern ?? ""}" ${input.path ?? ""}`;
      case "Glob":
        return `Glob: ${input.pattern ?? "unknown"}`;
      case "AskUserQuestion": {
        // Claude CLI の AskUserQuestion ツール: input.question に質問テキストが入る
        const question = (input.question as string) ?? (input.text as string) ?? "";
        return `Question: ${question.substring(0, 200)}`;
      }
      default:
        return toolName;
    }
  }

  /** ツール結果の概要文字列を生成 */
  private buildToolResultSummary(toolName: string, content: string, isError: boolean): string {
    if (isError) return `${toolName}: error`;
    const truncated = content?.substring(0, 80) ?? "";
    return `${toolName}: ${truncated}`;
  }
}
