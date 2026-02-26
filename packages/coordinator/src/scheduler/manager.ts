import cron, { ScheduledTask } from "node-cron";
import { PermissionMode, ScheduleJob } from "@claude-discord/common";
import { ScheduleStore } from "./store.js";
import { TaskManager, TaskCreateOptions } from "../task/manager.js";

/** 曜日の日本語名 */
const WEEKDAY_NAMES = [
  "日曜日",
  "月曜日",
  "火曜日",
  "水曜日",
  "木曜日",
  "金曜日",
  "土曜日",
];

/**
 * スケジュールジョブの管理。
 * node-cron でジョブの登録・解除・実行を行い、
 * 既存の TaskManager フローに乗せて定期タスクを実行する。
 */
export class ScheduleManager {
  /** 稼働中の cron タスク */
  private cronTasks: Map<string, ScheduledTask> = new Map();

  /** ジョブ実行時のコールバック */
  public onJobExecuted:
    | ((job: ScheduleJob, taskId: string) => Promise<void>)
    | null = null;

  constructor(
    private readonly store: ScheduleStore,
    private readonly taskManager: TaskManager
  ) {}

  /**
   * 起動時に全ジョブを読み込んで cron 登録する
   */
  loadAll(): void {
    const jobs = this.store.getAll();
    let registered = 0;
    for (const job of jobs) {
      if (job.enabled) {
        this.registerCron(job);
        registered++;
      }
    }
    console.log(
      `[ScheduleManager] Loaded ${jobs.length} jobs (${registered} enabled)`
    );
  }

  /**
   * ジョブを追加する
   */
  addJob(
    name: string,
    cronExpression: string,
    prompt: string,
    createdBy: string,
    workerId: string | null = null,
    cwd: string | null = null
  ): ScheduleJob {
    // cron式のバリデーション
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }

    // 名前の重複チェック
    if (this.store.getByName(name)) {
      throw new Error(`Schedule "${name}" already exists`);
    }

    const job: ScheduleJob = {
      id: this.store.nextId(),
      name,
      cronExpression,
      prompt,
      workerId,
      cwd,
      enabled: true,
      lastRunAt: null,
      lastTaskId: null,
      createdBy,
    };

    this.store.add(job);
    this.registerCron(job);

    console.log(
      `[ScheduleManager] Added job "${name}" (${cronExpression})`
    );
    return job;
  }

  /**
   * ジョブを削除する
   */
  removeJob(name: string): boolean {
    const job = this.store.getByName(name);
    if (!job) return false;

    this.unregisterCron(job.id);
    this.store.remove(job.id);

    console.log(`[ScheduleManager] Removed job "${name}"`);
    return true;
  }

  /**
   * ジョブの有効/無効を切り替える
   */
  toggleJob(name: string): ScheduleJob | null {
    const job = this.store.getByName(name);
    if (!job) return null;

    const updated = this.store.update(job.id, { enabled: !job.enabled });
    if (!updated) return null;

    if (updated.enabled) {
      this.registerCron(updated);
    } else {
      this.unregisterCron(updated.id);
    }

    console.log(
      `[ScheduleManager] Toggled job "${name}" → ${updated.enabled ? "enabled" : "disabled"}`
    );
    return updated;
  }

  /**
   * ジョブを即時実行する
   */
  async runNow(name: string): Promise<string> {
    const job = this.store.getByName(name);
    if (!job) {
      throw new Error(`Schedule "${name}" not found`);
    }

    return await this.executeJob(job);
  }

  /**
   * ジョブを実行する（cron 発火 or 手動実行）
   */
  async executeJob(job: ScheduleJob): Promise<string> {
    const now = new Date();

    // テンプレート変数を置換
    const resolvedPrompt = this.replaceTemplateVars(job.prompt, now);

    // TaskManager でタスクを作成
    const options: TaskCreateOptions = {
      prompt: resolvedPrompt,
      requestedBy: `scheduler:${job.name}`,
      workerId: job.workerId,
      cwd: job.cwd,
      permissionMode: PermissionMode.Auto,
    };

    const task = this.taskManager.createTask(options);

    // ジョブの最終実行情報を更新
    this.store.update(job.id, {
      lastRunAt: now.getTime(),
      lastTaskId: task.id,
    });

    console.log(
      `[ScheduleManager] Executing job "${job.name}" → ${task.id}`
    );

    // コールバック発火
    if (this.onJobExecuted) {
      await this.onJobExecuted(job, task.id);
    }

    // ディスパッチ試行
    await this.taskManager.dispatchNext();

    return task.id;
  }

  /**
   * 全ジョブを取得する
   */
  getAll(): ScheduleJob[] {
    return this.store.getAll();
  }

  /**
   * 名前でジョブを検索する
   */
  getByName(name: string): ScheduleJob | undefined {
    return this.store.getByName(name);
  }

  /**
   * 全 cron ジョブを停止する
   */
  destroy(): void {
    for (const [id, task] of this.cronTasks) {
      task.stop();
    }
    this.cronTasks.clear();
    console.log("[ScheduleManager] All cron jobs stopped");
  }

  // ─── Private ───

  /**
   * cron タスクを登録する
   */
  private registerCron(job: ScheduleJob): void {
    // 既存の cron があれば停止
    this.unregisterCron(job.id);

    const task = cron.schedule(
      job.cronExpression,
      () => {
        // 最新のジョブ情報を取得して実行
        const latestJob = this.store.getById(job.id);
        if (latestJob && latestJob.enabled) {
          this.executeJob(latestJob).catch((err) => {
            console.error(
              `[ScheduleManager] Failed to execute job "${job.name}":`,
              err
            );
          });
        }
      },
      { timezone: "Asia/Tokyo" }
    );

    this.cronTasks.set(job.id, task);
  }

  /**
   * cron タスクを解除する
   */
  private unregisterCron(jobId: string): void {
    const existing = this.cronTasks.get(jobId);
    if (existing) {
      existing.stop();
      this.cronTasks.delete(jobId);
    }
  }

  /**
   * テンプレート変数を置換する
   */
  replaceTemplateVars(text: string, now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");

    const date = `${year}-${month}-${day}`;
    const datetime = `${date} ${hours}:${minutes}`;
    const weekday = WEEKDAY_NAMES[now.getDay()];

    return text
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{datetime\}\}/g, datetime)
      .replace(/\{\{weekday\}\}/g, weekday);
  }
}
