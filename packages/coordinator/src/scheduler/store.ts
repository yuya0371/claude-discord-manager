import fs from "node:fs";
import path from "node:path";
import type { ScheduleJob } from "@claude-discord/common";

/**
 * スケジュールジョブの CRUD 管理。
 * インメモリ + JSON ファイル永続化（aliases.ts と同パターン）。
 */
export class ScheduleStore {
  private jobs: Map<string, ScheduleJob> = new Map();
  private idCounter = 0;

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** 次のジョブIDを生成する */
  nextId(): string {
    this.idCounter++;
    return `sched-${this.idCounter}`;
  }

  /** ジョブを追加する */
  add(job: ScheduleJob): void {
    this.jobs.set(job.id, job);
    this.save();
  }

  /** ジョブを削除する */
  remove(id: string): boolean {
    const existed = this.jobs.delete(id);
    if (existed) {
      this.save();
    }
    return existed;
  }

  /** ジョブを更新する */
  update(id: string, partial: Partial<ScheduleJob>): ScheduleJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    const updated = { ...job, ...partial, id: job.id };
    this.jobs.set(id, updated);
    this.save();
    return updated;
  }

  /** 全ジョブを取得する */
  getAll(): ScheduleJob[] {
    return Array.from(this.jobs.values());
  }

  /** 名前でジョブを検索する */
  getByName(name: string): ScheduleJob | undefined {
    return this.getAll().find((j) => j.name === name);
  }

  /** IDでジョブを取得する */
  getById(id: string): ScheduleJob | undefined {
    return this.jobs.get(id);
  }

  /** JSON ファイルからジョブを読み込む */
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(data) as ScheduleJob[];
      for (const job of parsed) {
        this.jobs.set(job.id, job);
        // IDカウンターを既存の最大値に合わせる
        const num = parseInt(job.id.replace("sched-", ""), 10);
        if (!isNaN(num) && num > this.idCounter) {
          this.idCounter = num;
        }
      }
    } catch (err) {
      console.warn(
        `[ScheduleStore] Failed to load schedules from ${this.filePath}:`,
        (err as Error).message
      );
    }
  }

  /** ジョブを JSON ファイルに保存する */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.getAll(), null, 2);
      fs.writeFileSync(this.filePath, data, "utf-8");
    } catch (err) {
      console.error(
        `[ScheduleStore] Failed to save schedules to ${this.filePath}:`,
        (err as Error).message
      );
    }
  }
}
