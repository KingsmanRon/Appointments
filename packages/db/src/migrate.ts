import { pool } from "./index.js";
import { readFile } from "node:fs/promises";
const sql = await readFile(
  new URL("../../../supabase/migrations/0001_access.sql", import.meta.url),
  "utf8",
);
await pool.query(sql);
console.log("migration 0001 applied");
await pool.end();
