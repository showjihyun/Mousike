// One-off migration runner. Reads every .sql file in this directory in
// lexical order and executes it against DATABASE_URL. Idempotent SQL (CREATE
// TABLE IF NOT EXISTS, etc.) means re-runs are safe.
import "dotenv/config";
import { readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Add it to server/.env.");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const files = (await readdir(__dirname))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      console.log(`→ ${f}`);
      const sql = await readFile(join(__dirname, f), "utf8");
      await client.query(sql);
    }
    console.log("✓ migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
