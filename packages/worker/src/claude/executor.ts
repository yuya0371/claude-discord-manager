// packages/worker/src/claude/executor.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PermissionMode } from "@claude-discord/common";
import { StreamJsonParser, type ParsedEvent } from "./parser.js";

export interface ExecuteOptions {
  prompt: string;
  cwd: string;
  permissionMode: PermissionMode;
  teamMode: boolean;
  sessionId: string | null;
  attachmentPaths: string[];
}

export interface ExecutorEvents {
  stream: (event: ParsedEvent) => void;
  exit: (code: number | null, signal: string | null) => void;
  error: (error: Error) => void;
  stderr: (data: string) => void;
}

/** 既知の異常終了コードとその意味 */
const EXIT_CODE_DESCRIPTIONS: Record<number, string> = {
  1: "General error",
  2: "Misuse of shell command / invalid arguments",
  126: "Command not executable",
  127: "Command not found (claude CLI not installed?)",
  128: "Invalid exit argument",
  130: "Terminated by Ctrl+C (SIGINT)",
  137: "Killed (SIGKILL / OOM)",
  139: "Segmentation fault (SIGSEGV)",
  143: "Terminated (SIGTERM)",
};

/**
 * Claude CLI の子プロセスを管理する。
 * child_process.spawn で CLI を実行し、stdout を StreamJsonParser でパースする。
 */
export class ClaudeExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private parser = new StreamJsonParser();
  private _running = false;

  get running(): boolean {
    return this._running;
  }

  /** Claude CLI を実行する */
  execute(options: ExecuteOptions): void {
    if (this._running) {
      throw new Error("ClaudeExecutor is already running");
    }

    const args = this.buildArgs(options);
    this.parser.reset();
    this._running = true;

    console.log(`[Executor] Spawning: claude ${args.join(" ")}`);
    console.log(`[Executor] CWD: ${options.cwd}`);
    if (options.sessionId) {
      console.log(`[Executor] Resuming session: ${options.sessionId}`);
    }

    // CWD の存在チェック
    if (!existsSync(options.cwd)) {
      this._running = false;
      const error = new Error(`Working directory does not exist: ${options.cwd}`);
      console.error(`[Executor] ${error.message}`);
      this.emit("error", error);
      return;
    }

    // 親プロセス (Claude Code) の環境変数を除外して子プロセスに渡す
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("CLAUDE")) {
        delete childEnv[key];
      }
    }

    try {
      this.process = spawn("claude", args, {
        cwd: options.cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      // stdin パイプを即座に end() して EOF を送信する。
      // Claude CLI は stdin がパイプだとデータ待ちでハングするため、
      // EOF を送ることで通常の -p モード実行として進行させる。
      // 質問応答はセッション継続 (--resume) で対応する。
      this.process.stdin?.end();
    } catch (err) {
      this._running = false;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[Executor] Failed to spawn process:`, error.message);
      this.emit("error", error);
      return;
    }

    // stdout: stream-json 出力を行単位で読み取り
    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    // stderr: エラー出力の収集
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      console.warn(`[Executor] stderr: ${text}`);
      this.emit("stderr", text);
    });

    // プロセス終了: close イベントを使うことで、stdio ストリームが
    // 全て閉じた後に発火する（stderr のデータを取りこぼさない）
    this.process.on("close", (code, signal) => {
      this._running = false;
      this.process = null;

      // 異常終了コードの詳細ログ
      if (code !== null && code !== 0) {
        const description = EXIT_CODE_DESCRIPTIONS[code] ?? "Unknown error";
        console.error(`[Executor] Process crashed: code=${code} (${description}), signal=${signal}`);
      } else if (signal) {
        console.warn(`[Executor] Process killed by signal: ${signal}`);
      } else {
        console.log(`[Executor] Process exited normally: code=${code}`);
      }

      this.emit("exit", code, signal);
    });

    this.process.on("error", (err) => {
      this._running = false;
      this.process = null;
      console.error(`[Executor] Process error:`, err.message);
      this.emit("error", err);
    });
  }

  /** タスクキャンセル時の処理 */
  async kill(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    proc.kill("SIGTERM");

    // 5秒以内に終了しなければ SIGKILL
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);

      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 終了コードの説明を取得する */
  static getExitCodeDescription(code: number): string {
    return EXIT_CODE_DESCRIPTIONS[code] ?? "Unknown error";
  }

  /** stdin に入力を書き込む(質問応答・権限応答用) */
  writeStdin(_input: string): void {
    // stdin は起動直後に end() しているため書き込み不可。
    // 質問応答はセッション継続 (--resume) で対応する。
    console.warn("[Executor] writeStdin is not supported; use session continuation instead");
  }

  /** CLI 引数を組み立てる */
  private buildArgs(options: ExecuteOptions): string[] {
    let prompt = options.prompt;

    // 添付ファイルがある場合、プロンプトにファイルパスを含める
    if (options.attachmentPaths.length > 0) {
      const fileRefs = options.attachmentPaths.map((p) => `[Attached file: ${p}]`).join("\n");
      prompt = `${prompt}\n\n${fileRefs}`;
    }

    const args: string[] = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

    if (options.permissionMode === PermissionMode.Auto) {
      args.push("--dangerouslySkipPermissions");
    }

    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }

    return args;
  }

  /** stdout chunk を parser に渡し、イベントを emit する */
  private handleStdoutChunk(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    const events = this.parser.parse(text);
    for (const event of events) {
      this.emit("stream", event);
    }
  }
}
