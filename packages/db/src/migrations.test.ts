import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations.ts";
import { MIGRATIONS_DIR } from "./migrator.ts";

const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan(MIGRATIONS_DIR))).sort();

describe("embedded migrations", () => {
  test("list every file in migrations/, in order", () => {
    expect(MIGRATIONS.map((migration) => migration.name)).toEqual(files);
  });

  // The checksum in schema_migrations was taken from the file, so the embedded text must match it byte
  // for byte, or a database migrated from source would refuse to start with the compiled bot.
  test.each(files)("%s is embedded byte for byte", async (name) => {
    const embedded = MIGRATIONS.find((migration) => migration.name === name);
    expect(embedded?.content).toBe(await Bun.file(`${MIGRATIONS_DIR}${name}`).text());
  });
});
