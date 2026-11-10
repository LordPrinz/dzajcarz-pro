// One-off: applies repository settings, labels, branch rules and autolinks. Run locally:
//   bun run gh:setup-repo
import { TRUNK_BRANCH } from "../git/conventions.ts";

const REQUIRED_CHECKS = ["Conventions", "Lint", "Typecheck", "Test"];
const TOPICS = [
  "discord-bot",
  "discord-js",
  "lavalink",
  "music-bot",
  "bun",
  "typescript",
  "monorepo",
  "postgresql",
  "redis",
];

/** Labels drive the project fields (scripts/gh/setup-project.ts maps them to Area, Priority, Size). */
const LABELS = [
  { name: "type:feature", color: "1d76db", description: "New functionality" },
  { name: "type:bug", color: "d73a4a", description: "Something is broken" },
  { name: "type:chore", color: "c5def5", description: "Tooling, config, maintenance" },
  { name: "type:spike", color: "fbca04", description: "Time-boxed research / experiment" },
  { name: "type:docs", color: "0075ca", description: "Documentation" },
  { name: "area:core", color: "5319e7", description: "core, bot app, db, kv" },
  { name: "area:music", color: "0e8a16", description: "Lavalink player module" },
  { name: "area:moderation", color: "b60205", description: "ban, kick, timeout, warn, purge" },
  { name: "area:party", color: "f9a8d4", description: "Party area voice channels" },
  { name: "area:welcome", color: "1abc9c", description: "Greetings for new members" },
  { name: "area:fun", color: "fef2c0", description: "Dzajco, trivia, small commands" },
  { name: "area:infra", color: "e99695", description: "CI/CD, deployment, tooling" },
  { name: "area:docs", color: "bfdadc", description: "DESIGN.md, ADRs" },
  { name: "priority:P0", color: "b60205", description: "Blocks other work" },
  { name: "priority:P1", color: "fbca04", description: "Needed this sprint" },
  { name: "priority:P2", color: "c2e0c6", description: "Nice to have" },
  { name: "size:S", color: "ededed", description: "≤ half a day" },
  { name: "size:M", color: "d4c5f9", description: "1–2 days" },
  { name: "size:L", color: "f9d0c4", description: "> 2 days — consider splitting" },
];
/** GitHub's default labels; replaced by the prefixed ones above. */
const DEFAULT_LABELS = [
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
];

const { nameWithOwner: repo } = (await Bun.$`gh repo view --json nameWithOwner`.quiet().json()) as {
  nameWithOwner: string;
};

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `repos/${repo}${path}`;
  const result = body
    ? await Bun.$`gh api -X ${method} ${url} --input - < ${Buffer.from(JSON.stringify(body))}`.quiet()
    : await Bun.$`gh api -X ${method} ${url}`.quiet();
  const text = result.text();
  return text ? JSON.parse(text) : null;
}

// GitHub refuses a default branch that does not exist yet.
const trunk = await Bun.$`gh api ${`repos/${repo}/branches/${TRUNK_BRANCH}`}`.quiet().nothrow();
if (trunk.exitCode !== 0) {
  console.error(
    `Branch ${TRUNK_BRANCH} is not on GitHub yet. Push it first: git push -u origin ${TRUNK_BRANCH}`,
  );
  process.exit(1);
}

await api("PATCH", "", {
  description:
    "Dzajcarz — Discord bot on Bun: music (Lavalink), party voice channels, moderation, welcome messages and fun commands. Slash and prefix commands.",
  // v5 is an orphan branch that replaces the old code; main and dzajcarzv4 stay as history.
  default_branch: TRUNK_BRANCH,
  has_wiki: true,
  has_projects: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  allow_update_branch: true,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "BLANK",
});
console.info(
  `✓ settings: default branch ${TRUNK_BRANCH}, squash merge only (PR title), auto-delete branches, auto-merge`,
);

await api("PUT", "/topics", { names: TOPICS });
console.info(`✓ topics: ${TOPICS.join(", ")}`);

const autolinks = (await api("GET", "/autolinks")) as { key_prefix: string }[];
if (!autolinks.some((a) => a.key_prefix === "DZAJ-")) {
  await api("POST", "/autolinks", {
    key_prefix: "DZAJ-",
    url_template: `https://github.com/${repo}/issues/<num>`,
    is_alphanumeric: false,
  });
}
console.info("✓ autolink: DZAJ-<n> → issue #<n>");

const existingLabels = new Set(
  ((await api("GET", "/labels?per_page=100")) as { name: string }[]).map((l) => l.name),
);
for (const label of LABELS) {
  if (existingLabels.has(label.name)) {
    await api("PATCH", `/labels/${encodeURIComponent(label.name)}`, label);
  } else {
    await api("POST", "/labels", label);
  }
}
for (const name of DEFAULT_LABELS) {
  if (existingLabels.has(name)) await api("DELETE", `/labels/${encodeURIComponent(name)}`);
}
console.info(`✓ labels: ${LABELS.length} type/area/priority/size labels, GitHub defaults removed`);

await api("PUT", "/vulnerability-alerts");
await api("PUT", "/automated-security-fixes");
console.info("✓ Dependabot alerts and security updates");

const ruleset = {
  name: "trunk",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  // Admins may merge their own PR without an approval (useful while working solo), never push directly.
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_linear_history" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: REQUIRED_CHECKS.map((context) => ({ context })),
      },
    },
  ],
};
const rulesets = (await api("GET", "/rulesets")) as { id: number; name: string }[];
const existing = rulesets.find((r) => r.name === ruleset.name);
await api(existing ? "PUT" : "POST", existing ? `/rulesets/${existing.id}` : "/rulesets", ruleset);
console.info(
  `✓ ruleset on ${TRUNK_BRANCH}: PR + 1 approval, squash only, linear history, checks: ${REQUIRED_CHECKS.join(", ")}`,
);
