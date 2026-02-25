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

/**
 * ボタンインタラクション（権限確認・質問応答）のハンドラ
 */
export class ButtonHandler {
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
      .setTimestamp();

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
      await channel.send({ embeds: [embed], components: [row] });
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
      await channel.send({ embeds: [embed], components: [row] });
    }
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

    await channel.send({ embeds: [embed], components: [row] });
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
}
