import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const sqliteStorage = () => {
  const database = new DatabaseSync(":memory:");
  const statements: Array<{ query: string; bindings: SQLInputValue[]; columns: string[] }> = [];
  const storage = {
    sql: {
      exec(query: string, ...bindings: SQLInputValue[]) {
        const statement = database.prepare(query);
        statements.push({ query, bindings, columns: statement.columns().map((column) => column.name) });
        const rows = statement.all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as Pick<DurableObjectStorage, "sql" | "transactionSync">;
  return { storage, database, statements };
};
