import pg from "pg";
import { migrate, seedSynthetic } from "../../packages/db/src/index.js";

/** A fresh synthetic database for the browser run (test databases only). */
export default async function setup() {
  const url =
    process.env.BROWSER_DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/access_browser_test";
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/test/i.test(name))
    throw new Error(`refusing to reset "${name}": use a test database`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = new pg.Client({ connectionString: admin.toString() });
  await server.connect();
  try {
    const exists = await server.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [name],
    );
    if (!exists.rowCount)
      await server.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  } finally {
    await server.end();
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;",
    );
    await migrate(pool);
    await pool.query(
      "ALTER ROLE access_request LOGIN PASSWORD 'integration-api'; ALTER ROLE access_worker LOGIN PASSWORD 'integration-worker';",
    );
    await seedSynthetic(pool);
  } finally {
    await pool.end();
  }
}
