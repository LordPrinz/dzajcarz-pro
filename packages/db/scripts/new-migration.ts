// bun run db:new add_warnings → migrations/0002_add_warnings.sql
import { MIGRATIONS_DIR } from "../src/migrator.ts";

const name = Bun.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error("Usage: bun run db:new <snake_case_name>");
  process.exit(1);
}

const files = await Array.fromAsync(new Bun.Glob("*.sql").scan(MIGRATIONS_DIR));
const next = Math.max(0, ...files.map((f) => Number.parseInt(f, 10) || 0)) + 1;
const path = `${MIGRATIONS_DIR}${String(next).padStart(4, "0")}_${name}.sql`;
await Bun.write(path, "-- Write forward-only SQL. Never edit a migration that has been applied.\n");
console.info(`Created ${path}`);
console.info(
  "Add it to src/migrations.ts so the compiled bot embeds it (a test fails until you do).",
);
