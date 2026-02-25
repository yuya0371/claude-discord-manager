// packages/common/src/logger.ts

/** ログレベル */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 構造化ログエントリ */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * コンポーネント名、レベル、タイムスタンプ付きの構造化ロガー。
 * 環境変数 LOG_LEVEL で出力レベルを制御可能（デフォルト: info）。
 */
export class Logger {
  private readonly minLevel: LogLevel;

  constructor(private readonly component: string) {
    const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
    this.minLevel = envLevel in LOG_LEVEL_PRIORITY
      ? (envLevel as LogLevel)
      : "info";
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
    };

    if (data) {
      entry.data = data;
    }

    const prefix = `${entry.timestamp} [${level.toUpperCase().padEnd(5)}] [${this.component}]`;
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${prefix} ${message}${suffix}`;

    switch (level) {
      case "debug":
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
  }
}
