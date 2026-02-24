import { TASK_MAX_QUEUE_SIZE } from "@claude-discord/common";

/**
 * シンプルなFIFOタスクキュー
 */
export class TaskQueue {
  private queue: string[] = [];

  /**
   * タスクIDをキューに追加する
   * @returns true: 追加成功, false: キューが満杯
   */
  enqueue(taskId: string): boolean {
    if (this.queue.length >= TASK_MAX_QUEUE_SIZE) {
      return false;
    }
    this.queue.push(taskId);
    return true;
  }

  /**
   * キューの先頭からタスクIDを取り出す
   * @returns タスクID、キューが空ならnull
   */
  dequeue(): string | null {
    return this.queue.shift() ?? null;
  }

  /**
   * 特定のタスクをキューから削除する
   * @returns 削除できたらtrue
   */
  remove(taskId: string): boolean {
    const index = this.queue.indexOf(taskId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /**
   * キュー内のタスクID一覧を取得（先頭から順に）
   */
  getAll(): string[] {
    return [...this.queue];
  }

  /**
   * キュー内にタスクがあるか
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * キューのサイズ
   */
  get size(): number {
    return this.queue.length;
  }
}
