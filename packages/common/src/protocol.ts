// packages/common/src/protocol.ts

import type { WsMessage, WsMessageType } from "./types.js";

/** WsMessageを生成する */
export function createMessage<T>(
  type: WsMessageType,
  payload: T,
  options?: { taskId?: string; workerId?: string },
): WsMessage<T> {
  return {
    type,
    payload,
    timestamp: Date.now(),
    ...options,
  };
}

/** 受信したJSON文字列をWsMessageにパースする */
export function parseMessage(raw: string): WsMessage {
  const msg = JSON.parse(raw) as WsMessage;
  if (!msg.type || msg.payload === undefined || !msg.timestamp) {
    throw new Error(`Invalid WsMessage: missing required fields`);
  }
  return msg;
}
