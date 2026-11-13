// Fails CI when the total coverage drops. Bun's own `coverageThreshold` applies to every file separately, so
// one thin adapter would fail the run; this reads the lcov report and checks the sum over all files.
//
// Usage: bun test --coverage --coverage-reporter=text --coverage-reporter=lcov && bun scripts/ci/coverage.ts

export interface CoverageMinimum {
  functions: number;
  lines: number;
}

/**
 * Just under the totals when this was added (functions 93.5%, lines 95.9%, summed over all files; Bun's
 * "All files" row averages the files instead). Raise them as coverage grows.
 */
export const MINIMUM: CoverageMinimum = { functions: 0.93, lines: 0.95 };

export interface CoverageTotals {
  functions: { found: number; hit: number };
  lines: { found: number; hit: number };
}

/** Sums the `FNF`/`FNH` and `LF`/`LH` records of every file in an lcov report. */
export function sumLcov(report: string): CoverageTotals {
  const totals: CoverageTotals = { functions: { found: 0, hit: 0 }, lines: { found: 0, hit: 0 } };
  for (const line of report.split("\n")) {
    const [key, raw] = line.split(":");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (key === "FNF") totals.functions.found += value;
    else if (key === "FNH") totals.functions.hit += value;
    else if (key === "LF") totals.lines.found += value;
    else if (key === "LH") totals.lines.hit += value;
  }
  return totals;
}

/** One line per metric under its minimum; empty when the totals pass. */
export function belowMinimum(totals: CoverageTotals, minimum: CoverageMinimum = MINIMUM): string[] {
  const problems: string[] = [];
  for (const metric of ["functions", "lines"] as const) {
    const { found, hit } = totals[metric];
    const ratio = found === 0 ? 1 : hit / found;
    if (ratio < minimum[metric]) {
      problems.push(
        `${metric}: ${(ratio * 100).toFixed(2)}% is below the minimum ${(minimum[metric] * 100).toFixed(0)}%`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const file = Bun.file("coverage/lcov.info");
  if (!(await file.exists())) {
    console.error(
      "coverage/lcov.info is missing; run bun test with --coverage-reporter=lcov first",
    );
    process.exit(1);
  }
  const totals = sumLcov(await file.text());
  if (totals.lines.found === 0) {
    console.error("coverage/lcov.info holds no line data; the report is empty or cut short");
    process.exit(1);
  }
  const problems = belowMinimum(totals);
  const percent = (metric: keyof CoverageTotals) =>
    ((totals[metric].hit / Math.max(1, totals[metric].found)) * 100).toFixed(2);
  console.log(`Coverage: functions ${percent("functions")}%, lines ${percent("lines")}%`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
}
