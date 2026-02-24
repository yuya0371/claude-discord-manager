# Claude Code Discord Manager

Discord から Claude Code CLI をリモート操作するためのマネージャーシステム。Coordinator Bot がユーザーのスラッシュコマンドを受け付け、Worker Agent が Claude CLI を実行し、結果をリアルタイムで Discord に返します。

## アーキテクチャ

```
Discord ユーザー
    |
    | スラッシュコマンド (/task)
    v
+-------------------+          WebSocket          +-------------------+
|   Coordinator     | <=========================> |   Worker Agent    |
|   (Discord Bot)   |    タスク割当/ストリーム     |                   |
|                   |                              |   Claude CLI      |
|  - コマンド受付   |                              |   (子プロセス)     |
|  - タスクキュー   |                              |  - stream-json    |
|  - Embed更新      |                              |    パース          |
|  - Worker管理     |                              |  - 結果送信        |
+-------------------+                              +-------------------+
```

- **Coordinator**: Discord Bot として動作。ユーザーからの `/task` コマンドを受け付け、Worker にタスクを配信し、実行状況を Discord Embed でリアルタイム表示する。
- **Worker**: Coordinator に WebSocket で接続。割り当てられたタスクに対して `claude` CLI を実行し、ストリーム出力を Coordinator へ送信する。
- **Common**: 両者が共有する型定義・プロトコル・定数を提供する共通パッケージ。

## 前提条件

- Node.js >= 18
- npm >= 9（workspaces 対応）
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications) で取得）
- Claude CLI がインストール済みであること（Worker 側）

## セットアップ

### 1. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新しい Application を作成
2. Bot セクションでトークンを取得
3. OAuth2 > URL Generator で `bot` と `applications.commands` スコープを選択
4. Bot Permissions で `Send Messages`, `Embed Links`, `Read Message History` を付与
5. 生成された URL でサーバーに Bot を招待

### 2. Discord チャンネルの準備

以下のチャンネルを作成し、各チャンネル ID を控えておく:

| チャンネル | 用途 |
|-----------|------|
| #command | コマンド送信用 |
| #status | タスク状況表示 |
| #token-usage | トークン使用量表示 |
| #teams | Agent Teams 表示 |
| #workers | Worker 状態表示 |

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して各値を設定:

```env
# Discord Bot
DISCORD_BOT_TOKEN=your-bot-token
GUILD_ID=your-guild-id
ALLOWED_USER_IDS=your-discord-user-id

# Discord Channels
CHANNEL_COMMAND=channel-id
CHANNEL_STATUS=channel-id
CHANNEL_TOKEN_USAGE=channel-id
CHANNEL_TEAMS=channel-id
CHANNEL_WORKERS=channel-id

# WebSocket
WS_PORT=8765
COORDINATOR_SECRET=your-random-secret
```

`ALLOWED_USER_IDS` には Bot 操作を許可するユーザー ID をカンマ区切りで指定します。

### 4. インストールとビルド

```bash
npm install
npm run build
```

## 使い方

### Coordinator の起動

```bash
npm run start:coordinator
```

### Worker の起動

```bash
npm run start:worker
```

Worker は起動時に Coordinator の WebSocket サーバーに自動接続し、認証を行います。

### Discord でのコマンド

| コマンド | 説明 |
|---------|------|
| `/task prompt:<テキスト>` | Claude にタスクを依頼する |
| `/workers` | 接続中の Worker 一覧を表示 |
| `/status [task_id]` | タスク状況を表示 |
| `/cancel task_id:<ID>` | タスクをキャンセル |

`/task` のオプション:

| オプション | 必須 | 説明 |
|-----------|------|------|
| `prompt` | Yes | Claude に送るプロンプト |
| `worker` | No | 実行先 Worker 名 |
| `directory` | No | 作業ディレクトリ |
| `mode` | No | 権限モード (acceptEdits / auto / confirm) |
| `team` | No | Agent Teams モードで実行 |
| `continue` | No | 前回セッションを継続 |

## プロジェクト構成

```
claude-discord-manager/
├── packages/
│   ├── common/           共通ライブラリ（型定義・プロトコル・定数）
│   │   └── src/
│   │       ├── types.ts
│   │       ├── protocol.ts
│   │       └── constants.ts
│   ├── coordinator/      Coordinator Bot
│   │   └── src/
│   │       ├── index.ts           エントリーポイント
│   │       ├── discord/
│   │       │   ├── bot.ts         Discord Bot 初期化
│   │       │   ├── commands.ts    スラッシュコマンド定義
│   │       │   └── embeds.ts      Embed 生成
│   │       ├── ws/
│   │       │   └── server.ts      WebSocket サーバー
│   │       ├── task/
│   │       │   ├── queue.ts       タスクキュー (FIFO)
│   │       │   └── manager.ts     タスク状態管理
│   │       └── worker/
│   │           └── registry.ts    Worker 登録・管理
│   └── worker/           Worker Agent
│       └── src/
│           ├── index.ts           エントリーポイント
│           ├── ws/
│           │   └── client.ts      WebSocket クライアント
│           └── claude/
│               ├── executor.ts    Claude CLI 実行
│               └── parser.ts      stream-json パーサー
├── package.json          monorepo ルート (npm workspaces)
└── tsconfig.base.json    TypeScript 共通設定
```

## ライセンス

MIT
