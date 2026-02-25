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

### pm2 によるデーモン化（推奨）

pm2 を使うと Coordinator と Worker をバックグラウンドで常駐起動できます。

```bash
# pm2 のインストール（未インストールの場合）
npm install -g pm2

# ビルド後に起動
npm run build
npm run pm2:start

# ステータス確認
npm run pm2:status

# ログ確認
npm run pm2:logs

# 再起動
npm run pm2:restart

# 停止
npm run pm2:stop
```

設定は `ecosystem.config.cjs` で管理されています。Worker を複数台起動する場合はこのファイルに `worker-2`, `worker-3` 等のエントリを追加し、それぞれの環境変数（`WORKER_NAME` 等）を設定してください。

ログファイルは `logs/` ディレクトリに出力されます。

### Discord でのコマンド

| コマンド | 説明 |
|---------|------|
| `/task prompt:<テキスト>` | Claude にタスクを依頼する |
| `/workers` | 接続中の Worker 一覧を表示 |
| `/status [task_id]` | タスク状況を表示（省略時は一覧 + セッション情報） |
| `/cancel task_id:<ID>` | タスクをキャンセル |
| `/alias add\|remove\|list` | プロジェクトエイリアスの管理 |
| `/token [view]` | トークン使用量を表示（summary / detail / worker） |
| `/teams` | アクティブな Agent Teams の一覧を表示 |
| `/notify level:<all\|important\|none>` | 通知レベルを設定 |
| `/help` | コマンドヘルプを表示 |

`/task` のオプション:

| オプション | 必須 | 説明 |
|-----------|------|------|
| `prompt` | Yes | Claude に送るプロンプト |
| `worker` | No | 実行先 Worker 名 |
| `directory` | No | 作業ディレクトリ（エイリアス対応） |
| `mode` | No | 権限モード (acceptEdits / auto / confirm) |
| `team` | No | Agent Teams モードで実行 |
| `continue` | No | 前回セッションを継続 |
| `attachment` | No | 添付ファイル（8MB以下） |

`/notify` の通知レベル:

| レベル | 動作 |
|-------|------|
| `all` | 全イベント（完了・エラー・質問・権限確認）で @メンション |
| `important` (default) | エラー・質問・権限確認のみ @メンション |
| `none` | @メンションなし |

## プロジェクト構成

```
claude-discord-manager/
├── packages/
│   ├── common/               共通ライブラリ（型定義・プロトコル・定数）
│   │   └── src/
│   │       ├── types.ts
│   │       ├── protocol.ts
│   │       └── constants.ts
│   ├── coordinator/          Coordinator Bot
│   │   └── src/
│   │       ├── index.ts              エントリーポイント
│   │       ├── discord/
│   │       │   ├── bot.ts            Discord Bot 初期化・イベント管理
│   │       │   ├── commands.ts       スラッシュコマンド定義・ハンドラ
│   │       │   ├── buttons.ts        ボタン/モーダル インタラクション
│   │       │   └── embeds.ts         Embed 生成ヘルパー
│   │       ├── ws/
│   │       │   └── server.ts         WebSocket サーバー
│   │       ├── task/
│   │       │   ├── queue.ts          タスクキュー (FIFO)
│   │       │   └── manager.ts        タスク状態管理
│   │       ├── worker/
│   │       │   └── registry.ts       Worker 登録・管理
│   │       ├── notification/
│   │       │   └── settings.ts       通知設定（メンション制御）
│   │       ├── token/
│   │       │   └── tracker.ts        トークン使用量トラッカー
│   │       └── project/
│   │           └── aliases.ts        プロジェクトエイリアス管理
│   └── worker/               Worker Agent
│       └── src/
│           ├── index.ts              エントリーポイント
│           ├── ws/
│           │   └── client.ts         WebSocket クライアント
│           ├── claude/
│           │   ├── executor.ts       Claude CLI 実行
│           │   └── parser.ts         stream-json パーサー
│           └── team/
│               └── monitor.ts        Agent Teams 監視
├── ecosystem.config.cjs      pm2 設定ファイル
├── package.json              monorepo ルート (npm workspaces)
└── tsconfig.base.json        TypeScript 共通設定
```

## ライセンス

MIT
