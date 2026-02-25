// packages/worker/src/team/watcher.ts

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import type {
  TeamInfo,
  TeamMember,
  TeamTask,
  TeamMessage,
} from "@claude-discord/common";

/** TeamWatcher のデバウンス間隔（ミリ秒） */
const DEBOUNCE_MS = 2_000;

/** 最近のメッセージの最大保持数 */
const MAX_RECENT_MESSAGES = 20;

/**
 * Agent Teams のファイルシステム監視を行う。
 * Claude Code の Agent Teams は ~/.claude/ 配下にチーム情報を書き出す。
 * このクラスはそのディレクトリを fs.watch で監視し、
 * 変更検知時に TeamInfo を構築して "update" イベントを発火する。
 */
export class TeamWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly claudeDir: string;
  private activeTeams: Map<string, TeamInfo> = new Map();

  constructor(private readonly workerId: string) {
    super();
    this.claudeDir = path.join(os.homedir(), ".claude");
  }

  /**
   * ファイルシステム監視を開始する
   */
  start(): void {
    const projectsDir = path.join(this.claudeDir, "projects");

    // projects ディレクトリが存在しなければ監視しない
    if (!fs.existsSync(projectsDir)) {
      console.log("[TeamWatcher] No ~/.claude/projects directory found, skipping watch");
      return;
    }

    try {
      // projects ディレクトリを再帰的に監視
      const watcher = fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        // JSONL やチーム関連ファイルの変更を検知
        if (filename.includes("team") || filename.endsWith(".json") || filename.endsWith(".jsonl")) {
          this.scheduleUpdate();
        }
      });
      this.watchers.push(watcher);
      console.log(`[TeamWatcher] Watching ${projectsDir}`);
    } catch (err) {
      console.warn("[TeamWatcher] Failed to watch projects directory:", (err as Error).message);
    }

    // 初回スキャン
    this.scanForTeams();
  }

  /**
   * 監視を停止する
   */
  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * 現在のアクティブなチーム一覧を取得する
   */
  getActiveTeams(): TeamInfo[] {
    return Array.from(this.activeTeams.values());
  }

  /**
   * デバウンス付きで更新をスケジュールする
   */
  private scheduleUpdate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scanForTeams();
    }, DEBOUNCE_MS);
  }

  /**
   * ~/.claude/projects 配下をスキャンしてチーム情報を収集する
   */
  private scanForTeams(): void {
    const projectsDir = path.join(this.claudeDir, "projects");
    if (!fs.existsSync(projectsDir)) return;

    const previousTeams = new Map(this.activeTeams);
    this.activeTeams.clear();

    try {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue;

        const projectDir = path.join(projectsDir, entry.name);
        this.scanProjectForTeams(projectDir, entry.name);
      }
    } catch (err) {
      console.warn("[TeamWatcher] Error scanning projects:", (err as Error).message);
    }

    // 変更があったチームの通知
    for (const [teamName, teamInfo] of this.activeTeams) {
      const prev = previousTeams.get(teamName);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(teamInfo)) {
        this.emit("update", teamInfo);
      }
    }
  }

  /**
   * プロジェクトディレクトリ内のチーム情報をスキャンする
   */
  private scanProjectForTeams(projectDir: string, projectName: string): void {
    // Claude Code の Agent Teams はセッション情報から検出する
    // sessions ファイルやタスクファイルを探索
    try {
      const files = fs.readdirSync(projectDir);

      for (const file of files) {
        // JSONL 形式のセッションログからチーム情報を抽出
        if (file.endsWith(".jsonl")) {
          const teamInfo = this.parseSessionLog(
            path.join(projectDir, file),
            projectName
          );
          if (teamInfo) {
            this.activeTeams.set(teamInfo.teamName, teamInfo);
          }
        }
      }
    } catch {
      // ディレクトリアクセスエラーは無視
    }
  }

  /**
   * セッションログ（JSONL）からチーム情報を抽出する
   */
  private parseSessionLog(filePath: string, projectName: string): TeamInfo | null {
    try {
      const stat = fs.statSync(filePath);
      // 1時間以内に更新されたファイルのみ対象
      if (Date.now() - stat.mtimeMs > 3_600_000) return null;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");

      const members: TeamMember[] = [];
      const tasks: TeamTask[] = [];
      const messages: TeamMessage[] = [];
      let teamName: string | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // SendMessage ツール呼び出しからチームメッセージを検出
          if (entry.type === "tool_use" && entry.tool_name === "SendMessage") {
            const input = entry.input;
            if (input?.type === "message" && input?.recipient && input?.content) {
              messages.push({
                from: "agent",
                to: input.recipient,
                summary: (input.summary ?? input.content.substring(0, 100)),
                timestamp: entry.timestamp ?? Date.now(),
              });
            }
          }

          // TaskCreate / TaskUpdate ツールからタスク情報を検出
          if (entry.type === "tool_use" && entry.tool_name === "TaskCreate") {
            const input = entry.input;
            if (input?.subject) {
              tasks.push({
                id: `t-${tasks.length + 1}`,
                subject: input.subject,
                status: "pending",
                owner: input.owner ?? null,
              });
              // チームモードの可能性が高い
              if (!teamName) {
                teamName = projectName;
              }
            }
          }

          if (entry.type === "tool_use" && entry.tool_name === "TaskUpdate") {
            const input = entry.input;
            if (input?.taskId && input?.status) {
              const existing = tasks.find((t) => t.id === input.taskId);
              if (existing) {
                existing.status = input.status;
                if (input.owner) existing.owner = input.owner;
              }
            }
          }

          // teammate の検出（SendMessage の recipient から）
          if (entry.type === "tool_use" && entry.tool_name === "SendMessage" && entry.input?.recipient) {
            const recipientName = entry.input.recipient;
            if (!members.find((m) => m.name === recipientName)) {
              members.push({
                name: recipientName,
                agentId: recipientName,
                agentType: "teammate",
                status: "active",
              });
            }
          }
        } catch {
          // 不正な JSON 行は無視
        }
      }

      if (!teamName || (members.length === 0 && tasks.length === 0)) {
        return null;
      }

      return {
        teamName,
        workerId: this.workerId,
        members,
        tasks,
        recentMessages: messages.slice(-MAX_RECENT_MESSAGES),
      };
    } catch {
      return null;
    }
  }
}
