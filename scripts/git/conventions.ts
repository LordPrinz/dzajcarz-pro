/** Shared naming rules for branches, commits and PR titles. */

/** Branch that PRs target. */
export const TRUNK_BRANCH = "main";

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "ci",
  "build",
] as const;

/** `DZAJ-44-set-user-permissions` */
export const BRANCH_PATTERN = /^DZAJ-(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `[DZAJ-44] chore: Set user permissions` (optional scope and `!` for breaking changes). */
export const HEADER_PATTERN = new RegExp(
  String.raw`^\[DZAJ-\d+\] (?:${COMMIT_TYPES.join("|")})(?:\([a-z0-9-]+\))?!?: \S.{2,}$`,
);

/** Branches that never carry a ticket number. */
export const UNTICKETED_BRANCHES = new Set([TRUNK_BRANCH, "HEAD"]);

/** Dependabot names its own branches (`dependabot/bun/zod-4.2.0`); its PR titles carry the umbrella ticket DZAJ-3. */
export const BOT_BRANCH_PATTERN = /^dependabot\/[\w./-]+$/;

/** Commits git generates itself; they are allowed without a ticket. */
export const GENERATED_HEADER = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;

/** A message that is git-generated (`fixup! …`) or already carries a ticket tag must not get another prefix. */
export function needsTicketPrefix(message: string): boolean {
  return !GENERATED_HEADER.test(message) && !/^\[DZAJ-\d+\]/.test(message);
}

export function ticketFromBranch(branch: string): string | undefined {
  const id = BRANCH_PATTERN.exec(branch)?.[1] ?? /^DZAJ-(\d+)/i.exec(branch)?.[1];
  return id ? `DZAJ-${id}` : undefined;
}

export async function currentBranch(): Promise<string> {
  // symbolic-ref also works before the first commit; it fails only on a detached HEAD.
  const result = await Bun.$`git symbolic-ref --short HEAD`.quiet().nothrow();
  return result.exitCode === 0 ? result.text().trim() : "HEAD";
}

export function fail(lines: string[]): never {
  console.error(`\n✖ ${lines.join("\n  ")}\n`);
  process.exit(1);
}
