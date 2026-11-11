import { expect, test } from "bun:test";
import { join } from "node:path";

// The compiled binary cannot serve `/` inside a test, so this keeps the HTML-import path (HTML + React
// bundle) under test in CI.
test("the UI bundles into an HTML page and a JavaScript chunk", async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "index.html")] });
  expect(result.success).toBe(true);
  const kinds = result.outputs.map((output) => output.type.split(";")[0]);
  expect(kinds).toContain("text/html");
  expect(
    kinds.some((type) => type === "text/javascript" || type === "application/javascript"),
  ).toBe(true);
});
