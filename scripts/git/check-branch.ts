import {
  BOT_BRANCH_PATTERN,
  BRANCH_PATTERN,
  currentBranch,
  fail,
  UNTICKETED_BRANCHES,
} from "./conventions.ts";

const branch = Bun.argv[2] ?? (await currentBranch());
if (
  !UNTICKETED_BRANCHES.has(branch) &&
  !BRANCH_PATTERN.test(branch) &&
  !BOT_BRANCH_PATTERN.test(branch)
) {
  fail([
    `Invalid branch name: "${branch}"`,
    "Expected: DZAJ-<number>-short-kebab-description (e.g. DZAJ-44-set-user-permissions)",
    "Create it from the issue: gh issue develop <number> --name DZAJ-<number>-… --checkout",
  ]);
}
