import { createDb } from "../src/index.ts";
import { migrate } from "../src/migrator.ts";

const url = Bun.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = createDb(url);
const applied = await migrate(sql);
await sql.close();
console.info(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
