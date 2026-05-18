// Migration runner. Each .sql in this directory runs once per database; the
// _migrations table tracks applied filenames. Files run in lexical order and
// each one runs inside its own transaction so a failure mid-file rolls back.
import "dotenv/config";
import { readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEDGER_DDL = `
  create table if not exists _migrations (
    filename    text primary key,
    applied_at  timestamptz not null default now()
  )
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Add it to server/.env.");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(LEDGER_DDL);
    const { rows } = await client.query<{ filename: string }>("select filename from _migrations");
    const applied = new Set(rows.map((r) => r.filename));

    const files = (await readdir(__dirname))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const f of files) {
      if (applied.has(f)) {
        console.log(`✓ ${f} (already applied)`);
        continue;
      }
      console.log(`→ ${f}`);
      const sql = await readFile(join(__dirname, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into _migrations (filename) values ($1)", [f]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
    console.log("✓ migrations up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
