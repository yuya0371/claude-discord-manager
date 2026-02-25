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
        const parsed = this.classifyEvent(json);
        events.push(...parsed);
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
   * 1つの JSON 行から複数のイベントを返すことがある（本体 + token_usage 等）。
   */
  private classifyEvent(json: Record<string, unknown>): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const type = json.type as string | undefined;

    switch (type) {
      case "assistant": {
        // assistant イベント: message.content にテキスト、message.usage にトークン数
        const message = json.message as Record<string, unknown> | undefined;
        const content = (message?.content ?? json.content) as Array<{ type: string; text?: string }> | undefined;
        const textBlock = content?.find((c) => c.type === "text");
        if (textBlock?.text) {
          events.push({
            eventType: "assistant_message",
            data: { text: textBlock.text },
          });
        }
        // message.usage からトークン使用量を抽出
        const msgUsage = message?.usage as Record<string, number> | undefined;
        if (msgUsage) {
          events.push(this.buildTokenUsageEvent(msgUsage));
        }
        break;
      }

      case "tool_use": {
        const toolName = json.name as string;
        const input = (json.input as Record<string, unknown>) ?? {};
        const summary = this.buildToolSummary(toolName, input);
        events.push({
          eventType: "tool_use_begin",
          data: { toolName, summary },
        });
        break;
      }

      // Claude CLI が AskUserQuestion を呼び出した場合
      case "ask_user": {
        const question = (json.question as string) ?? (json.text as string) ?? "";
        events.push({
          eventType: "tool_use_begin",
          data: { toolName: "AskUserQuestion", summary: `Question: ${question.substring(0, 80)}` },
        });
        break;
      }

      case "tool_result": {
        const toolName = ((json.tool_name ?? json.name ?? "unknown") as string);
        const isError = json.is_error as boolean | undefined;
        const content = (json.content as string) ?? "";
        const summary = this.buildToolResultSummary(toolName, content, !!isError);
        events.push({
          eventType: "tool_use_end",
          data: { toolName, summary, success: !isError },
        });
        break;
      }

      case "result": {
        const resultContent = (json.result as string) ?? "";
        const sessionId = (json.session_id as string) ?? null;
        const costUsd = (json.total_cost_usd as number) ?? null;
        events.push({
          eventType: "result",
          data: { text: resultContent, sessionId, costUsd },
        });
        // result イベントの modelUsage からトークン使用量を抽出（最終値）
        const modelUsage = json.modelUsage as Record<string, Record<string, number>> | undefined;
        if (modelUsage) {
          // modelUsage はモデル名をキーとした辞書。全モデルのトークンを合算
          let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
          for (const model of Object.values(modelUsage)) {
            inputTokens += model.inputTokens ?? 0;
            outputTokens += model.outputTokens ?? 0;
            cacheReadTokens += model.cacheReadInputTokens ?? 0;
            cacheWriteTokens += model.cacheCreationInputTokens ?? 0;
          }
          events.push({
            eventType: "token_usage",
            data: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
          });
        } else {
          // フォールバック: トップレベル usage
          const usage = json.usage as Record<string, number> | undefined;
          if (usage) {
            events.push(this.buildTokenUsageEvent(usage));
          }
        }
        break;
      }

      // レートリミット情報（残り使用率）
      case "rate_limit_event": {
        const info = json.rate_limit_info as Record<string, unknown> | undefined;
        if (info) {
          events.push({
            eventType: "rate_limit",
            data: {
              status: (info.status as string) ?? "unknown",
              resetsAt: (info.resetsAt as number) ?? null,
              rateLimitType: (info.rateLimitType as string) ?? null,
            },
          });
        }
        break;
      }

      default: {
        // 未知のイベントでも usage フィールドがあれば抽出
        const usage = json.usage as Record<string, number> | undefined;
        if (usage) {
          events.push(this.buildTokenUsageEvent(usage));
        }
        break;
      }
    }

    return events;
  }

  /** usage オブジェクトから token_usage イベントを生成 */
  private buildTokenUsageEvent(usage: Record<string, number>): ParsedEvent {
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
