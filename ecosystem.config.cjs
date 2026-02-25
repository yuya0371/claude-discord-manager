// pm2 ecosystem configuration
// Usage: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    {
      name: "coordinator",
      script: "packages/coordinator/dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      // ログ設定
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/coordinator-error.log",
      out_file: "logs/coordinator-out.log",
      merge_logs: true,
      // 自動再起動
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // クラッシュ時のウォッチ無効（手動再起動前提）
      watch: false,
    },
    {
      name: "worker-1",
      script: "packages/worker/dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      // ログ設定
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/worker-1-error.log",
      out_file: "logs/worker-1-out.log",
      merge_logs: true,
      // 自動再起動
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
    },
  ],
};
