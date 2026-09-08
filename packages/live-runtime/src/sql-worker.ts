import { parentPort } from "node:worker_threads";
import { parse } from "pgsql-ast-parser";
if (!parentPort) throw new Error("SQL parser requires a worker port.");
parentPort.on("message", (sql: string) => {
  try { parentPort!.postMessage({ ast: parse(sql) }); }
  catch { parentPort!.postMessage({ error: "SQL syntax is not supported by the selected PostgreSQL parser." }); }
});
parentPort.postMessage({ ready: true });
