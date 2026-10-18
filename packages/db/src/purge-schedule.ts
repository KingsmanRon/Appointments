import { createPool } from "./runtime.js";
import { purgeSchedule } from "./retention.js";

/**
 * Operator retention purge of one organisation's finished appointments
 * (docs/runbooks.md). Runs with the migration credential, never at runtime.
 * Without CONFIRM=yes it only counts and rolls back.
 *
 *   TENANT_ID=<uuid> PURGE_BEFORE=2025-01-01T00:00:00+02:00 OPERATOR="ops ticket 123" \
 *   [CONFIRM=yes] npm run schedule:purge
 */
const { MIGRATION_DATABASE_URL, TENANT_ID, PURGE_BEFORE, OPERATOR, CONFIRM } =
  process.env;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL required");
if (!TENANT_ID || !uuid.test(TENANT_ID))
  throw new Error("TENANT_ID (uuid) required");
if (!PURGE_BEFORE || !/[zZ]|[+-]\d\d:\d\d$/.test(PURGE_BEFORE))
  throw new Error("PURGE_BEFORE required, with an explicit offset");
if (!OPERATOR) throw new Error("OPERATOR required");
const pool = createPool({
  connectionString: MIGRATION_DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
  max: 1,
});
try {
  const result = await purgeSchedule(pool, {
    tenantId: TENANT_ID,
    before: new Date(PURGE_BEFORE),
    operator: OPERATOR,
    confirm: CONFIRM === "yes",
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
