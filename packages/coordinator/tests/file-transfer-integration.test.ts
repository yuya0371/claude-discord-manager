/**
 * 結合テスト: file:transfer -> file:transfer_ack フロー
 *
 * 実際の WebSocket サーバーを起動し、Coordinator が file:transfer を送信、
 * Worker(ws クライアント)が file:transfer_ack を返すフローをテストする。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { WsServer } from "../src/ws/server.js";
import { WorkerRegistry } from "../src/worker/registry.js";
import { TaskManager } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import {
  createMessage,
  parseMessage,
  PROTOCOL_VERSION,
  TaskStatus,
  type WorkerRegisterPayload,
  type WorkerRegisterAckPayload,
  type TaskAssignPayload,
  type FileTransferPayload,
  type FileTransferAckPayload,
  type FileAttachment,
  type WsMessage,
} from "@claude-discord/common";

let testPort = 19200;

function getNextPort(): number {
  return testPort++;
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function wsSend(ws: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(data, (err) => (err ? reject(err) : resolve()));
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(parseMessage(data.toString()));
    });
  });
}

async function registerWorker(
  ws: WebSocket,
  name: string,
  secret: string,
): Promise<WsMessage<WorkerRegisterAckPayload>> {
  const msg = createMessage<WorkerRegisterPayload>("worker:register", {
    name,
    secret,
    os: "test",
    nodeVersion: "v20.0.0",
    claudeCliVersion: "1.0.0",
    defaultCwd: "/tmp",
    allowedDirs: ["/tmp"],
    protocolVersion: PROTOCOL_VERSION,
  });
  await wsSend(ws, JSON.stringify(msg));
  return (await waitForMessage(ws)) as WsMessage<WorkerRegisterAckPayload>;
}

/** 複数メッセージを受信して type でフィルタする */
async function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<WsMessage[]> {
  const messages: WsMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(messages), // タイムアウトしても収集済みメッセージを返す
      timeoutMs,
    );
    const handler = (data: WebSocket.RawData) => {
      messages.push(parseMessage(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

describe("Integration: file:transfer flow", () => {
  let port: number;
  let server: WsServer;
  let registry: WorkerRegistry;
  let taskManager: TaskManager;
  let queue: TaskQueue;
  let clients: WebSocket[];

  beforeEach(async () => {
    port = getNextPort();
    queue = new TaskQueue();
    registry = new WorkerRegistry("test-secret");
    taskManager = new TaskManager(queue, registry);

    registry.onWorkerDisconnected = async (workerId, hadRunningTask) => {
      if (hadRunningTask) {
        await taskManager.handleWorkerDisconnect(workerId);
      }
    };

    server = new WsServer({ port, host: "127.0.0.1" }, registry, taskManager);
    await server.start();
    clients = [];
  });

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    registry.destroy();
    taskManager.destroy();
    await server.stop();
  });

  it("should transfer file to worker and receive ack before task:assign", async () => {
    const ws = await connectClient(port);
    clients.push(ws);
    await registerWorker(ws, "worker-ft", "test-secret");

    // fetch をモック: Discord CDN からのファイルダウンロード
    const fileContent = "Hello, this is test file content!";
    const fileBuffer = Buffer.from(fileContent);
    // ArrayBuffer を正確に生成（Buffer.buffer はオフセットを持つ場合がある）
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const attachments: FileAttachment[] = [
      {
        fileName: "test.txt",
        mimeType: "text/plain",
        size: fileContent.length,
        cdnUrl: "https://cdn.discordapp.com/attachments/123/456/test.txt",
        localPath: null,
      },
    ];

    const task = taskManager.createTask({
      prompt: "Review the file",
      requestedBy: "test-user",
      attachments,
    });

    // dispatchNext を非同期で呼ぶ（file:transfer → ack 待機がある）
    const dispatchPromise = taskManager.dispatchNext();

    // Worker 側: file:transfer を受信
    const transferMsg = await waitForMessage(ws) as WsMessage<FileTransferPayload>;
    expect(transferMsg.type).toBe("file:transfer");
    expect(transferMsg.payload.fileName).toBe("test.txt");
    expect(transferMsg.payload.mimeType).toBe("text/plain");
    expect(transferMsg.payload.taskId).toBe(task.id);

    // Base64 データを検証
    const decodedContent = Buffer.from(transferMsg.payload.data, "base64").toString();
    expect(decodedContent).toBe(fileContent);

    // Worker 側: file:transfer_ack を返す
    const ackMsg = createMessage<FileTransferAckPayload>(
      "file:transfer_ack",
      {
        taskId: task.id,
        fileName: "test.txt",
        success: true,
        localPath: "/tmp/claude-worker-files/task-1/test.txt",
      },
      { taskId: task.id, workerId: "worker-ft" },
    );
    await wsSend(ws, JSON.stringify(ackMsg));

    // dispatchNext の完了を待つ
    await dispatchPromise;

    // task:assign を受信
    const assignMsg = await waitForMessage(ws) as WsMessage<TaskAssignPayload>;
    expect(assignMsg.type).toBe("task:assign");
    expect(assignMsg.payload.prompt).toBe("Review the file");
    expect(assignMsg.payload.attachments).toHaveLength(1);
    expect(assignMsg.payload.attachments[0].localPath).toBe(
      "/tmp/claude-worker-files/task-1/test.txt",
    );

    // タスクが Running に
    expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);

    // fetch が呼ばれた
    expect(mockFetch).toHaveBeenCalledWith(
      "https://cdn.discordapp.com/attachments/123/456/test.txt",
    );

    vi.unstubAllGlobals();
  });

  it("should still dispatch task when file:transfer_ack indicates failure", async () => {
    const ws = await connectClient(port);
    clients.push(ws);
    await registerWorker(ws, "worker-ft-fail", "test-secret");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
    });
    vi.stubGlobal("fetch", mockFetch);

    const attachments: FileAttachment[] = [
      {
        fileName: "fail.bin",
        mimeType: "application/octet-stream",
        size: 10,
        cdnUrl: "https://cdn.discordapp.com/attachments/fail.bin",
        localPath: null,
      },
    ];

    const task = taskManager.createTask({
      prompt: "Try with failed file",
      requestedBy: "test-user",
      attachments,
    });

    const dispatchPromise = taskManager.dispatchNext();

    // file:transfer 受信
    const transferMsg = await waitForMessage(ws);
    expect(transferMsg.type).toBe("file:transfer");

    // Worker 側: 失敗の ack を返す
    const ackMsg = createMessage<FileTransferAckPayload>(
      "file:transfer_ack",
      {
        taskId: task.id,
        fileName: "fail.bin",
        success: false,
        localPath: null,
        error: "Disk full",
      },
      { taskId: task.id, workerId: "worker-ft-fail" },
    );
    await wsSend(ws, JSON.stringify(ackMsg));

    await dispatchPromise;

    // task:assign は送信されるが localPath は null のまま
    const assignMsg = await waitForMessage(ws) as WsMessage<TaskAssignPayload>;
    expect(assignMsg.type).toBe("task:assign");
    expect(assignMsg.payload.attachments[0].localPath).toBeNull();

    expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);

    vi.unstubAllGlobals();
  });

  it("should dispatch task even when file:transfer_ack times out", async () => {
    const ws = await connectClient(port);
    clients.push(ws);
    await registerWorker(ws, "worker-ft-timeout", "test-secret");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(5)),
    });
    vi.stubGlobal("fetch", mockFetch);

    const attachments: FileAttachment[] = [
      {
        fileName: "timeout.txt",
        mimeType: "text/plain",
        size: 5,
        cdnUrl: "https://cdn.discordapp.com/attachments/timeout.txt",
        localPath: null,
      },
    ];

    const task = taskManager.createTask({
      prompt: "Timeout file",
      requestedBy: "test-user",
      attachments,
    });

    // dispatchNext 呼び出し - Worker が ack を返さないのでタイムアウトする
    const dispatchPromise = taskManager.dispatchNext();

    // file:transfer 受信
    const transferMsg = await waitForMessage(ws);
    expect(transferMsg.type).toBe("file:transfer");

    // ack を返さずに待つ → タイムアウト(10秒)後にタスクがディスパッチされる
    await dispatchPromise;

    // task:assign が送信される（タイムアウト後）
    const assignMsg = await waitForMessage(ws) as WsMessage<TaskAssignPayload>;
    expect(assignMsg.type).toBe("task:assign");
    // localPath はタイムアウトで null のまま
    expect(assignMsg.payload.attachments[0].localPath).toBeNull();

    expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);

    vi.unstubAllGlobals();
  }, 15_000); // タイムアウトテストなので長めに設定

  it("should dispatch task without attachments when none provided", async () => {
    const ws = await connectClient(port);
    clients.push(ws);
    await registerWorker(ws, "worker-no-file", "test-secret");

    const task = taskManager.createTask({
      prompt: "No attachments",
      requestedBy: "test-user",
    });

    await taskManager.dispatchNext();

    const assignMsg = await waitForMessage(ws) as WsMessage<TaskAssignPayload>;
    expect(assignMsg.type).toBe("task:assign");
    expect(assignMsg.payload.attachments).toEqual([]);

    expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);
  });
});
