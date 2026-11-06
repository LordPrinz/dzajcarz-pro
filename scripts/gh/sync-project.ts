// Runs in GitHub Actions (see .github/workflows/project-sync.yml).
import { ticketFromBranch } from "../git/conventions.ts";
import {
  createGraphql,
  ensureIssueItem,
  getProject,
  type StatusName,
  setSingleSelect,
} from "./github.ts";

interface CreateEvent {
  ref: string;
  ref_type: "branch" | "tag";
}
interface PullRequestEvent {
  action: string;
  pull_request: {
    number: number;
    draft: boolean;
    body: string | null;
    head: { ref: string; repo: { fork: boolean } | null };
  };
}

const env = Bun.env;
const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/") as [string, string];
const event = (await Bun.file(env.GITHUB_EVENT_PATH ?? "").json()) as
  | CreateEvent
  | PullRequestEvent;

let branch: string;
let status: StatusName;
if (env.GITHUB_EVENT_NAME === "create") {
  const e = event as CreateEvent;
  if (e.ref_type !== "branch") process.exit(0);
  branch = e.ref;
  status = "In Progress";
} else {
  const { action, pull_request: pr } = event as PullRequestEvent;
  branch = pr.head.ref;
  status = pr.draft || action === "converted_to_draft" ? "In Progress" : "QA";
  // Fork PRs get a read-only token; their issue link is added by hand.
  if (!pr.head.repo?.fork) await ensureClosingKeyword(pr.number, pr.body ?? "", branch);
}

const ticket = ticketFromBranch(branch);
if (!ticket) {
  console.info(`Branch "${branch}" has no ticket, nothing to sync.`);
  process.exit(0);
}
const issueNumber = Number(ticket.slice("DZAJ-".length));

if (!env.PROJECTS_TOKEN) {
  console.warn("PROJECTS_TOKEN secret is not set; skipping board update.");
  process.exit(0);
}
const graphql = createGraphql(env.PROJECTS_TOKEN);
const project = await getProject(graphql, owner, Number(env.PROJECT_NUMBER));
const optionId = project.statusOptions.get(status);
if (!optionId) throw new Error(`Status option "${status}" missing on the board`);

const itemId = await ensureIssueItem(graphql, project, owner, repo, issueNumber);
if (!itemId) {
  console.warn(`Issue #${issueNumber} not found; skipping.`);
  process.exit(0);
}
await setSingleSelect(graphql, project.id, itemId, project.statusFieldId, optionId);
console.info(`#${issueNumber} → ${status}`);

/** Adds "Closes #n" so merging the PR closes the issue (and the board moves it to Done). */
async function ensureClosingKeyword(prNumber: number, body: string, headRef: string) {
  const id = ticketFromBranch(headRef)?.slice("DZAJ-".length);
  if (
    !id ||
    new RegExp(String.raw`\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${id}\b`, "i").test(body)
  ) {
    return;
  }
  const newBody = /^Closes #\s*$/m.test(body)
    ? body.replace(/^Closes #\s*$/m, `Closes #${id}`)
    : `${body}\n\nCloses #${id}`.trim();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: newBody }),
  });
  if (!res.ok) throw new Error(`Failed to update PR body: ${res.status} ${await res.text()}`);
  console.info(`PR #${prNumber}: linked to #${id}`);
}
