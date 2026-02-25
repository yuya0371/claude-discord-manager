import { NotifyLevel } from "@claude-discord/common";

/**
 * ユーザーごとの通知設定を管理する（インメモリ）
 */
export class NotificationSettings {
  /** ユーザーID -> 通知レベル */
  private settings: Map<string, NotifyLevel> = new Map();

  /** デフォルトの通知レベル */
  private readonly defaultLevel = NotifyLevel.Important;

  /**
   * ユーザーの通知レベルを取得する
   */
  getLevel(userId: string): NotifyLevel {
    return this.settings.get(userId) ?? this.defaultLevel;
  }

  /**
   * ユーザーの通知レベルを設定する
   */
  setLevel(userId: string, level: NotifyLevel): void {
    this.settings.set(userId, level);
  }

  /**
   * 指定イベント種別に対してメンションすべきか判定する
   */
  shouldMention(
    userId: string,
    eventType: NotificationEventType
  ): boolean {
    const level = this.getLevel(userId);

    switch (level) {
      case NotifyLevel.All:
        return true;

      case NotifyLevel.Important:
        // エラー・確認質問・権限確認のみ
        return (
          eventType === "error" ||
          eventType === "question" ||
          eventType === "permission"
        );

      case NotifyLevel.None:
        return false;
    }
  }

  /**
   * 特定イベントでメンションすべきユーザーIDリストを返す
   */
  getUsersToMention(
    userIds: string[],
    eventType: NotificationEventType
  ): string[] {
    return userIds.filter((id) => this.shouldMention(id, eventType));
  }

  /**
   * メンション文字列を生成する
   */
  buildMentionText(
    userIds: string[],
    eventType: NotificationEventType
  ): string {
    const mentions = this.getUsersToMention(userIds, eventType);
    if (mentions.length === 0) return "";
    return mentions.map((id) => `<@${id}>`).join(" ");
  }
}

/** 通知イベントの種別 */
export type NotificationEventType =
  | "completed"
  | "error"
  | "question"
  | "permission";
