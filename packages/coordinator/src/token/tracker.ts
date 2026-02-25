import { TokenUsage, TokenUsageRecord } from "@claude-discord/common";

/**
 * トークン使用量の集計結果
 */
export interface TokenSummary {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  taskCount: number;
}

/**
 * Worker別トークン使用量
 */
export interface WorkerTokenSummary {
  workerId: string;
  summary: TokenSummary;
}

/**
 * トークン使用量のトラッキングと集計を行うクラス
 * インメモリで記録し、Worker別・日別の集計メソッドを提供する
 */
export class TokenTracker {
  private records: TokenUsageRecord[] = [];

  /**
   * タスク完了時にトークン使用量を記録する
   */
  record(taskId: string, workerId: string, usage: TokenUsage): void {
    this.records.push({
      taskId,
      workerId,
      usage,
      timestamp: Date.now(),
    });
  }

  /**
   * 全レコードを取得する
   */
  getAllRecords(): TokenUsageRecord[] {
    return [...this.records];
  }

  /**
   * 指定日のレコードを取得する（デフォルトは今日）
   */
  getRecordsByDate(date?: Date): TokenUsageRecord[] {
    const target = date ?? new Date();
    const startOfDay = new Date(
      target.getFullYear(),
      target.getMonth(),
      target.getDate()
    ).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    return this.records.filter(
      (r) => r.timestamp >= startOfDay && r.timestamp < endOfDay
    );
  }

  /**
   * 今日のトークン使用量サマリーを取得する
   */
  getTodaySummary(): TokenSummary {
    return this.summarize(this.getRecordsByDate());
  }

  /**
   * Worker別の使用量サマリーを取得する（デフォルトは今日）
   */
  getWorkerSummaries(date?: Date): WorkerTokenSummary[] {
    const records = date ? this.getRecordsByDate(date) : this.getRecordsByDate();
    const workerMap = new Map<string, TokenUsageRecord[]>();

    for (const record of records) {
      const existing = workerMap.get(record.workerId) ?? [];
      existing.push(record);
      workerMap.set(record.workerId, existing);
    }

    const summaries: WorkerTokenSummary[] = [];
    for (const [workerId, workerRecords] of workerMap) {
      summaries.push({
        workerId,
        summary: this.summarize(workerRecords),
      });
    }

    return summaries;
  }

  /**
   * タスク別の詳細レコード一覧を取得する（デフォルトは今日）
   */
  getTaskDetails(date?: Date): TokenUsageRecord[] {
    return date ? this.getRecordsByDate(date) : this.getRecordsByDate();
  }

  /**
   * 累計トークン数を算出する
   */
  getCumulativeSummary(): TokenSummary {
    return this.summarize(this.records);
  }

  /**
   * レコード群からサマリーを算出する
   */
  private summarize(records: TokenUsageRecord[]): TokenSummary {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;

    for (const r of records) {
      totalInput += r.usage.inputTokens;
      totalOutput += r.usage.outputTokens;
      totalCacheRead += r.usage.cacheReadTokens;
      totalCacheWrite += r.usage.cacheWriteTokens;
    }

    return {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      taskCount: records.length,
    };
  }
}
