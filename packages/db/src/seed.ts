import { pool } from "./index.js";
import { readFile } from "node:fs/promises";
const sql = await readFile(
  new URL("../../../supabase/seed.sql", import.meta.url),
  "utf8",
);
await pool.query(sql);
console.log("synthetic fixtures seeded");
await pool.end();
