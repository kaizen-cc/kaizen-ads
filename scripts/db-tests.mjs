// Runs supabase/tests/*.sql against the database and fails if any rule check fails.
// Each file runs in a transaction that is always rolled back, so it's safe on production.
// Needs SUPABASE_DB_URL (Supabase → Connect → Session pooler connection string).
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.log("SUPABASE_DB_URL not set — skipping database rule checks.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
let failed = 0;
try {
  for (const file of readdirSync("supabase/tests").filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`supabase/tests/${file}`, "utf8");
    try {
      const results = [].concat(await client.query(sql));
      const rows = results.at(-1)?.rows ?? [];
      console.log(`\n${file}`);
      for (const r of rows) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.test}${r.ok ? "" : ` — ${r.detail}`}`);
        if (!r.ok) failed++;
      }
      if (!rows.length) {
        console.log("  ✗ returned no results");
        failed++;
      }
    } finally {
      await client.query("rollback");
    }
  }
} finally {
  await client.end();
}
if (failed) {
  console.error(`\n${failed} rule check(s) failed`);
  process.exit(1);
}
console.log("\nAll database rules hold.");
