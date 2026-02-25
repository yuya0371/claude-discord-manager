import fs from "node:fs";
import path from "node:path";
import type { ProjectAlias } from "@claude-discord/common";

/**
 * プロジェクトエイリアスの CRUD 管理。
 * インメモリ + JSON ファイル永続化。
 */
export class ProjectAliasManager {
  private aliases: Map<string, ProjectAlias> = new Map();

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** エイリアスを追加/更新する */
  add(alias: string, aliasPath: string, preferredWorker: string | null = null): ProjectAlias {
    const entry: ProjectAlias = {
      alias,
      path: aliasPath,
      preferredWorker,
    };
    this.aliases.set(alias, entry);
    this.save();
    return entry;
  }

  /** エイリアスを削除する */
  remove(alias: string): boolean {
    const existed = this.aliases.delete(alias);
    if (existed) {
      this.save();
    }
    return existed;
  }

  /** エイリアスを取得する */
  get(alias: string): ProjectAlias | undefined {
    return this.aliases.get(alias);
  }

  /** 全エイリアス一覧を取得する */
  getAll(): ProjectAlias[] {
    return Array.from(this.aliases.values());
  }

  /**
   * ディレクトリ文字列を解決する。
   * "@エイリアス名" 形式の場合、エイリアスのパスに解決する。
   * 通常のパスの場合はそのまま返す。
   *
   * @returns { resolvedPath, preferredWorker } or null (エイリアスが見つからない場合)
   */
  resolve(directory: string): { resolvedPath: string; preferredWorker: string | null } | null {
    if (!directory.startsWith("@")) {
      return { resolvedPath: directory, preferredWorker: null };
    }

    const aliasName = directory.slice(1);
    const entry = this.aliases.get(aliasName);
    if (!entry) {
      return null;
    }

    return {
      resolvedPath: entry.path,
      preferredWorker: entry.preferredWorker,
    };
  }

  /** JSON ファイルからエイリアスを読み込む */
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(data) as ProjectAlias[];
      for (const entry of parsed) {
        this.aliases.set(entry.alias, entry);
      }
    } catch (err) {
      console.warn(`[AliasManager] Failed to load aliases from ${this.filePath}:`, (err as Error).message);
    }
  }

  /** エイリアスを JSON ファイルに保存する */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.getAll(), null, 2);
      fs.writeFileSync(this.filePath, data, "utf-8");
    } catch (err) {
      console.error(`[AliasManager] Failed to save aliases to ${this.filePath}:`, (err as Error).message);
    }
  }
}
