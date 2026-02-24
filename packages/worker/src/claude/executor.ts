// packages/worker/src/claude/executor.ts

import { spawn, type ChildProcess } from "node:child_process";
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

    this.process = spawn("claude", args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

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

    // プロセス終了
    this.process.on("exit", (code, signal) => {
      this._running = false;
      this.process = null;
      console.log(`[Executor] Process exited: code=${code}, signal=${signal}`);
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

  /** stdin に入力を書き込む(質問応答・権限応答用) */
  writeStdin(input: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(input + "\n");
    }
  }

  /** CLI 引数を組み立てる */
  private buildArgs(options: ExecuteOptions): string[] {
    let prompt = options.prompt;

    // 添付ファイルがある場合、プロンプトにファイルパスを含める
    if (options.attachmentPaths.length > 0) {
      const fileRefs = options.attachmentPaths.map((p) => `[Attached file: ${p}]`).join("\n");
      prompt = `${prompt}\n\n${fileRefs}`;
    }

    const args: string[] = ["-p", prompt, "--output-format", "stream-json"];

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
