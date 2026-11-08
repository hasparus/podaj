import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const sqliteStorage = () => {
  const database = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query: string, ...bindings: SQLInputValue[]) {
        const rows = database.prepare(query).all(...bindings);
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
  return { storage, database };
};
