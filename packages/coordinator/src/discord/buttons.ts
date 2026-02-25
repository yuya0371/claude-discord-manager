import {
  ButtonInteraction,
  ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextChannel,
  EmbedBuilder,
  Colors,
  Message,
} from "discord.js";
import {
  TaskQuestionPayload,
  TaskPermissionPayload,
  TaskAnswerPayload,
  TaskPermissionResponsePayload,
  createMessage,
} from "@claude-discord/common";
import { WorkerRegistry } from "../worker/registry.js";
import { TaskManager } from "../task/manager.js";
import { buildTaskEmbed } from "./embeds.js";

/** 質問応答のタイムアウト (5分) */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/** 権限確認のタイムアウト (3分) */
const PERMISSION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * ボタンインタラクション（権限確認・質問応答）のハンドラ
 */
export class ButtonHandler {
  /** タイムアウトタイマー管理: key = `question:${taskId}:${questionId}` or `permission:${taskId}:${permissionId}` */
  private readonly timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: WorkerRegistry,
    private readonly allowedUserIds: string[],
    private readonly statusChannelId: string
  ) {}

  /**
   * task:question 受信時に Discord へボタン付きメッセージを投稿する
   */
  async postQuestionMessage(
    channel: TextChannel,
    taskId: string,
    payload: TaskQuestionPayload
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle(`[Question] Task ${taskId}`)
      .setDescription(payload.question)
      .setFooter({ text: `${QUESTION_TIMEOUT_MS / 60000}分以内に回答してください` })
      .setTimestamp();

    let sentMessage: Message;

    if (payload.options && payload.options.length > 0) {
      // 選択肢ボタンを生成
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (let i = 0; i < payload.options.length && i < 5; i++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(
              `question:${taskId}:${payload.questionId}:${i}`
            )
            .setLabel(payload.options[i])
            .setStyle(ButtonStyle.Primary)
        );
      }
      sentMessage = await channel.send({ embeds: [embed], components: [row] });
    } else {
      // 自由入力用ボタン
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `question_input:${taskId}:${payload.questionId}`
          )
          .setLabel("回答を入力")
          .setStyle(ButtonStyle.Primary)
      );
      sentMessage = await channel.send({ embeds: [embed], components: [row] });
    }

    // タイムアウトタイマーを設定
    this.startQuestionTimeout(taskId, payload.questionId, sentMessage);
  }

  /**
   * task:permission 受信時に Discord へ許可/拒否ボタン付きメッセージを投稿する
   */
  async postPermissionMessage(
    channel: TextChannel,
    taskId: string,
    payload: TaskPermissionPayload
  ): Promise<void> {
    const typeLabel =
      payload.permissionType === "bash" ? "Bash 実行" : "ファイル編集";
    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle(`[Permission] Task ${taskId} - ${typeLabel}`)
      .addFields(
        { name: "Command", value: "```\n" + payload.command + "\n```" },
        { name: "CWD", value: payload.cwd, inline: true }
      )
      .setFooter({ text: `${PERMISSION_TIMEOUT_MS / 60000}分以内に応答してください` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `permission:${taskId}:${payload.permissionId}:grant`
        )
        .setLabel("許可")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          `permission:${taskId}:${payload.permissionId}:deny`
        )
        .setLabel("拒否")
        .setStyle(ButtonStyle.Danger)
    );

    const sentMessage = await channel.send({ embeds: [embed], components: [row] });

    // タイムアウトタイマーを設定
    this.startPermissionTimeout(taskId, payload.permissionId, sentMessage);
  }

  /**
   * ButtonInteraction をハンドリングする
   */
  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!this.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({
        content: "権限がありません",
        ephemeral: true,
      });
      return;
    }

    const parts = interaction.customId.split(":");
    const actionType = parts[0];

    switch (actionType) {
      case "question":
        await this.handleQuestionButton(interaction, parts);
        break;
      case "question_input":
        await this.handleQuestionInputModal(interaction, parts);
        break;
      case "permission":
        await this.handlePermissionButton(interaction, parts);
        break;
      case "reply":
        await this.handleReplyModal(interaction, parts);
        break;
      default:
        await interaction.reply({
          content: "Unknown action",
          ephemeral: true,
        });
    }
  }

  /**
   * ModalSubmitInteraction をハンドリングする
   */
  async handleModalSubmit(
    interaction: ModalSubmitInteraction
  ): Promise<void> {
    if (!this.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({
        content: "権限がありません",
        ephemeral: true,
      });
      return;
    }

    const parts = interaction.customId.split(":");
    const actionType = parts[0];

    if (actionType === "question_modal") {
      await this.handleQuestionModalSubmit(interaction, parts);
    } else if (actionType === "reply_modal") {
      await this.handleReplyModalSubmit(interaction, parts);
    }
  }

  /**
   * 全タイムアウトタイマーをクリアする（シャットダウン時用）
   */
  clearAllTimeouts(): void {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();
  }

  // --- Timeout management ---

  /** 質問応答のタイムアウトタイマーを開始する */
  private startQuestionTimeout(
    taskId: string,
    questionId: string,
    message: Message
  ): void {
    const key = `question:${taskId}:${questionId}`;

    const timer = setTimeout(async () => {
      this.timeoutTimers.delete(key);
      try {
        const timeoutEmbed = new EmbedBuilder()
          .setColor(Colors.DarkRed)
          .setTitle(`[Question Timeout] Task ${taskId}`)
          .setDescription("回答がタイムアウトしました（5分経過）")
          .setTimestamp();

        await message.edit({
          embeds: [timeoutEmbed],
          components: [],
        });
      } catch (err) {
        console.error(`[ButtonHandler] Failed to update timed-out question message:`, err);
      }
    }, QUESTION_TIMEOUT_MS);

    this.timeoutTimers.set(key, timer);
  }

  /** 権限確認のタイムアウトタイマーを開始する */
  private startPermissionTimeout(
    taskId: string,
    permissionId: string,
    message: Message
  ): void {
    const key = `permission:${taskId}:${permissionId}`;

    const timer = setTimeout(async () => {
      this.timeoutTimers.delete(key);
      try {
        // タイムアウト時は自動的に拒否として扱う
        const task = this.taskManager.getTask(taskId);
        if (task?.workerId) {
          const permMsg = createMessage<TaskPermissionResponsePayload>(
            "task:permission_response",
            { permissionId, granted: false },
            { taskId, workerId: task.workerId }
          );
          this.workerRegistry.sendToWorker(task.workerId, permMsg);
        }

        const timeoutEmbed = new EmbedBuilder()
          .setColor(Colors.DarkRed)
          .setTitle(`[Permission Timeout] Task ${taskId}`)
          .setDescription("権限確認がタイムアウトしました（3分経過）- 自動拒否")
          .setTimestamp();

        await message.edit({
          embeds: [timeoutEmbed],
          components: [],
        });
      } catch (err) {
        console.error(`[ButtonHandler] Failed to update timed-out permission message:`, err);
      }
    }, PERMISSION_TIMEOUT_MS);

    this.timeoutTimers.set(key, timer);
  }

  /** タイムアウトタイマーをクリアする */
  private clearTimeout(key: string): void {
    const timer = this.timeoutTimers.get(key);
    if (timer) {
      globalThis.clearTimeout(timer);
      this.timeoutTimers.delete(key);
    }
  }

  // --- Private handlers ---

  /**
   * 選択肢ボタン押下: task:answer を Worker に送信
   * customId: question:<taskId>:<questionId>:<optionIndex>
   */
  private async handleQuestionButton(
    interaction: ButtonInteraction,
    parts: string[]
  ): Promise<void> {
    const taskId = parts[1];
    const questionId = parts[2];
    const optionIndex = parseInt(parts[3], 10);

    // タイムアウトタイマーをクリア
    this.clearTimeout(`question:${taskId}:${questionId}`);

    const task = this.taskManager.getTask(taskId);
    if (!task || !task.workerId) {
      await interaction.reply({
        content: "Task not found or not running.",
        ephemeral: true,
      });
      return;
    }

    // ボタンのラベルを回答テキストとして取得
    const component = interaction.component;
    const answer = ("label" in component ? component.label : null) ?? String(optionIndex);

    const answerMsg = createMessage<TaskAnswerPayload>(
      "task:answer",
      { questionId, answer },
      { taskId, workerId: task.workerId }
    );
    this.workerRegistry.sendToWorker(task.workerId, answerMsg);

    await interaction.update({
      content: `Answered: "${answer}"`,
      components: [],
    });
  }

  /**
   * 自由入力ボタン押下: モーダルを表示
   * customId: question_input:<taskId>:<questionId>
   */
  private async handleQuestionInputModal(
    interaction: ButtonInteraction,
    parts: string[]
  ): Promise<void> {
    const taskId = parts[1];
    const questionId = parts[2];

    const modal = new ModalBuilder()
      .setCustomId(`question_modal:${taskId}:${questionId}`)
      .setTitle("回答を入力");

    const answerInput = new TextInputBuilder()
      .setCustomId("answer_text")
      .setLabel("回答")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
      answerInput
    );
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  /**
   * モーダル送信: task:answer を Worker に送信
   * customId: question_modal:<taskId>:<questionId>
   */
  private async handleQuestionModalSubmit(
    interaction: ModalSubmitInteraction,
    parts: string[]
  ): Promise<void> {
    const taskId = parts[1];
    const questionId = parts[2];

    // タイムアウトタイマーをクリア
    this.clearTimeout(`question:${taskId}:${questionId}`);

    const task = this.taskManager.getTask(taskId);
    if (!task || !task.workerId) {
      await interaction.reply({
        content: "Task not found or not running.",
        ephemeral: true,
      });
      return;
    }

    const answer =
      interaction.fields.getTextInputValue("answer_text");

    const answerMsg = createMessage<TaskAnswerPayload>(
      "task:answer",
      { questionId, answer },
      { taskId, workerId: task.workerId }
    );
    this.workerRegistry.sendToWorker(task.workerId, answerMsg);

    await interaction.reply({
      content: `Answered: "${answer.substring(0, 100)}${answer.length > 100 ? "..." : ""}"`,
      ephemeral: true,
    });
  }

  /**
   * 権限確認ボタン押下: task:permission_response を Worker に送信
   * customId: permission:<taskId>:<permissionId>:<grant|deny>
   */
  private async handlePermissionButton(
    interaction: ButtonInteraction,
    parts: string[]
  ): Promise<void> {
    const taskId = parts[1];
    const permissionId = parts[2];
    const action = parts[3]; // "grant" or "deny"

    // タイムアウトタイマーをクリア
    this.clearTimeout(`permission:${taskId}:${permissionId}`);

    const task = this.taskManager.getTask(taskId);
    if (!task || !task.workerId) {
      await interaction.reply({
        content: "Task not found or not running.",
        ephemeral: true,
      });
      return;
    }

    const granted = action === "grant";

    const permMsg = createMessage<TaskPermissionResponsePayload>(
      "task:permission_response",
      { permissionId, granted },
      { taskId, workerId: task.workerId }
    );
    this.workerRegistry.sendToWorker(task.workerId, permMsg);

    const resultText = granted ? "許可しました" : "拒否しました";
    await interaction.update({
      content: resultText,
      components: [],
    });
  }

  // --- Reply (session continuation) handlers ---

  /**
   * 返信ボタン押下: モーダルを表示
   * customId: reply:<taskId>:<sessionId>
   */
  private async handleReplyModal(
    interaction: ButtonInteraction,
    parts: string[]
  ): Promise<void> {
    const taskId = parts[1];
    const sessionId = parts[2];

    const modal = new ModalBuilder()
      .setCustomId(`reply_modal:${taskId}:${sessionId}`)
      .setTitle("返信を入力");

    const answerInput = new TextInputBuilder()
      .setCustomId("reply_text")
      .setLabel("メッセージ")
      .setPlaceholder("Claudeへの返信を入力してください")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(answerInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  /**
   * 返信モーダル送信: セッション継続で新しいタスクを作成する
   * customId: reply_modal:<taskId>:<sessionId>
   */
  private async handleReplyModalSubmit(
    interaction: ModalSubmitInteraction,
    parts: string[]
  ): Promise<void> {
    const originalTaskId = parts[1];
    const sessionId = parts[2];

    const replyText = interaction.fields.getTextInputValue("reply_text");
    const originalTask = this.taskManager.getTask(originalTaskId);

    if (!originalTask) {
      await interaction.reply({
        content: "元のタスクが見つかりません。",
        ephemeral: true,
      });
      return;
    }

    // セッション継続で新しいタスクを作成
    const newTask = this.taskManager.createTask({
      prompt: replyText,
      cwd: originalTask.cwd,
      permissionMode: originalTask.permissionMode,
      requestedBy: interaction.user.id,
      sessionId,
      continueSession: true,
    });

    // #status チャンネルに Embed を投稿
    const channel = interaction.client.channels.cache.get(this.statusChannelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      const embed = buildTaskEmbed(newTask);
      const msg = await (channel as TextChannel).send({ embeds: [embed] });
      this.taskManager.setDiscordMessageId(newTask.id, msg.id);
    }

    // 元のメッセージのボタンを無効化
    try {
      await interaction.message?.edit({ components: [] });
    } catch { /* ignore */ }

    await interaction.reply({
      content: `セッション継続タスク **${newTask.id}** を作成しました。`,
      ephemeral: true,
    });

    // タスクのディスパッチ
    await this.taskManager.dispatchNext();
  }
}
