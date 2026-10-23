import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BindParams, Database as SqlDatabase, SqlValue, SqlJsStatic } from "sql.js";

const require = createRequire(import.meta.url);

type Row = Record<string, SqlValue>;

export class AppDatabase {
  private depth = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly file: string,
  ) {}

  exec(sql: string): void {
    this.db.exec(sql);
    this.touch();
  }

  prepare(sql: string): {
    run: (...params: SqlValue[]) => { changes: number };
    get: (...params: SqlValue[]) => Row | undefined;
    all: (...params: SqlValue[]) => Row[];
  } {
    return {
      run: (...params: SqlValue[]) => {
        if (params.length > 0) this.db.run(sql, params as BindParams);
        else this.db.run(sql);
        const changes = this.db.getRowsModified();
        this.touch();
        return { changes };
      },
      get: (...params: SqlValue[]) => {
        const statement = this.db.prepare(sql);
        if (params.length > 0) statement.bind(params as BindParams);
        const row = statement.step()
          ? (statement.getAsObject() as Row)
          : undefined;
        statement.free();
        return row;
      },
      all: (...params: SqlValue[]) => {
        const statement = this.db.prepare(sql);
        if (params.length > 0) statement.bind(params as BindParams);
        const rows: Row[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as Row);
        statement.free();
        return rows;
      },
    };
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.run("BEGIN");
      this.depth += 1;
      try {
        const result = fn();
        this.depth -= 1;
        this.db.run("COMMIT");
        this.persist();
        return result;
      } catch (error) {
        this.depth -= 1;
        try {
          this.db.run("ROLLBACK");
        } catch {
          // The statement error may already have ended the transaction.
        }
        throw error;
      }
    };
  }

  private touch(): void {
    if (this.depth === 0) this.persist();
  }

  private persist(): void {
    if (this.file === ":memory:") return;
    const bytes = this.db.export();
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, Buffer.from(bytes));
    renameSync(temporary, this.file);
  }
}

let sqlModule: Promise<SqlJsStatic> | undefined;

async function loadSql(): Promise<SqlJsStatic> {
  if (!sqlModule) {
    const initSqlJs = require("sql.js") as (config?: {
      wasmBinary?: Buffer;
    }) => Promise<SqlJsStatic>;
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    sqlModule = initSqlJs({ wasmBinary: readFileSync(wasmPath) });
  }
  return sqlModule;
}

export function resolveDatabaseFile(databaseUrl: string): string {
  if (databaseUrl === ":memory:" || databaseUrl === "file::memory:") {
    return ":memory:";
  }
  const raw = databaseUrl.startsWith("file:")
    ? databaseUrl.slice("file:".length)
    : databaseUrl;
  return raw.startsWith("/") ? raw : resolve(process.cwd(), raw);
}

export async function openDatabase(databaseUrl: string): Promise<AppDatabase> {
  const SQL = await loadSql();
  const file = resolveDatabaseFile(databaseUrl);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const existing = file !== ":memory:" && existsSync(file) ? readFileSync(file) : undefined;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  return new AppDatabase(db, file);
}

export function migrate(db: AppDatabase): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../migrations/001_init.sql"),
    resolve(process.cwd(), "migrations/001_init.sql"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Database migration 001_init.sql was not found.");
  db.exec(readFileSync(path, "utf8"));
  const applied = db
    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get("001_init");
  if (!applied) {
    db.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run("001_init", new Date().toISOString());
  }
}
