import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
if (!process.env.MIGRATION_DATABASE_URL && !process.env.DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL required");
const pool = new pg.Pool({
  connectionString:
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
});
const directory = new URL("../../../supabase/migrations/", import.meta.url);
for (const file of (await readdir(directory))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  await pool.query(await readFile(new URL(file, directory), "utf8"));
  console.log(`migration ${file} applied`);
}
await pool.end();
