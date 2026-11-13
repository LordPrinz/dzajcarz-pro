// One-off: creates and wires the project board. Run locally after `gh auth refresh -s project`:
//   bun run gh:setup-project
import {
  createGraphql,
  ensureIssueItem,
  getProject,
  STATUS_OPTIONS,
  setSingleSelect,
} from "./github.ts";

const TITLE = "Dzajcarz";
const SPRINT_START = "2026-11-09";
const SPRINT_DAYS = 14;
const SPRINT_COUNT = 8;

type Color = "GRAY" | "BLUE" | "GREEN" | "YELLOW" | "ORANGE" | "RED" | "PINK" | "PURPLE";
interface ExistingOption {
  id: string;
  name: string;
  color?: Color;
  description?: string;
}
interface Option {
  name: string;
  color: Color;
  description: string;
  /** Issue label that maps to this option. */
  label: string;
}

const SELECT_FIELDS: Record<string, Option[]> = {
  Area: [
    { name: "Core", color: "PURPLE", description: "core, bot app, db, kv", label: "area:core" },
    { name: "Music", color: "BLUE", description: "Lavalink player module", label: "area:music" },
    {
      name: "Moderation",
      color: "RED",
      description: "ban, kick, timeout, warn, purge",
      label: "area:moderation",
    },
    { name: "Party", color: "PINK", description: "Party area voice channels", label: "area:party" },
    {
      name: "Welcome",
      color: "GREEN",
      description: "Greetings for new members",
      label: "area:welcome",
    },
    {
      name: "Fun",
      color: "YELLOW",
      description: "Trivia, small commands",
      label: "area:fun",
    },
    {
      name: "Infra",
      color: "ORANGE",
      description: "CI/CD, deployment, tooling",
      label: "area:infra",
    },
    {
      name: "Schedule",
      color: "BLUE",
      description: "Scheduled songs and messages",
      label: "area:schedule",
    },
    {
      name: "Messages",
      color: "PINK",
      description: "Stored and scheduled messages",
      label: "area:messages",
    },
    {
      name: "Riot",
      color: "RED",
      description: "Riot stats (Valorant, League)",
      label: "area:riot",
    },
    { name: "Dzajco", color: "YELLOW", description: '"What" to gif replies', label: "area:dzajco" },
    {
      name: "Settings",
      color: "PURPLE",
      description: "Per-guild settings",
      label: "area:settings",
    },
    { name: "Web", color: "GREEN", description: "Web panel", label: "area:web" },
    { name: "Docs", color: "GRAY", description: "DESIGN.md, ADRs", label: "area:docs" },
  ],
  Priority: [
    { name: "P0", color: "RED", description: "Blocks other work", label: "priority:P0" },
    { name: "P1", color: "YELLOW", description: "Needed this sprint", label: "priority:P1" },
    { name: "P2", color: "GRAY", description: "Nice to have", label: "priority:P2" },
  ],
  Size: [
    { name: "S", color: "GREEN", description: "≤ half a day", label: "size:S" },
    { name: "M", color: "YELLOW", description: "1–2 days", label: "size:M" },
    { name: "L", color: "RED", description: "> 2 days — consider splitting", label: "size:L" },
  ],
};

const README = `## Workflow
Backlog → Todo → In Progress → QA → Done

- Every task is a GitHub issue (no drafts): \`DZAJ-<n>\` = issue \`#<n>\`.
- Branch \`DZAJ-<n>-short-description\` (issue → "Create a branch", or \`gh issue develop\`).
- Commit / PR title: \`[DZAJ-<n>] type: Description\` — added automatically from the branch name.
- Pushing the branch → **In Progress**, opening a PR → **QA**, merging → **Done**.
- QA = code review + manual check; 1 approval required.

See CONTRIBUTING.md in the repository for roles and conventions.`;

const manual: string[] = [];
const gh = (strings: TemplateStringsArray, ...values: Bun.ShellExpression[]) =>
  Bun.$(strings, ...values).quiet();

const token = (await gh`gh auth token`.text()).trim();
const graphql = createGraphql(token);
const repoInfo = (await gh`gh repo view --json name,owner`.json()) as {
  name: string;
  owner: { login: string };
};
const owner = repoInfo.owner.login;
const repo = repoInfo.name;

// --- 1. Project ---------------------------------------------------------------
const ids = await graphql<{ repository: { id: string; owner: { id: string } } }>(
  `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) { id owner { id } }
  }`,
  { owner, repo },
);

const found = await graphql<{
  repositoryOwner: { projectsV2?: { nodes: { number: number; title: string }[] } } | null;
}>(
  `query($owner: String!, $title: String!) {
    repositoryOwner(login: $owner) {
      ... on User { projectsV2(first: 20, query: $title) { nodes { number title } } }
      ... on Organization { projectsV2(first: 20, query: $title) { nodes { number title } } }
    }
  }`,
  { owner, title: TITLE },
);
let number = found.repositoryOwner?.projectsV2?.nodes.find((p) => p.title === TITLE)?.number;

if (number) {
  console.info(`Using existing project #${number}`);
} else {
  const created = await graphql<{ createProjectV2: { projectV2: { number: number } } }>(
    `mutation($ownerId: ID!, $repositoryId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, repositoryId: $repositoryId, title: $title }) {
        projectV2 { number }
      }
    }`,
    { ownerId: ids.repository.owner.id, repositoryId: ids.repository.id, title: TITLE },
  );
  number = created.createProjectV2.projectV2.number;
  console.info(`Created project #${number}`);
}

let project = await getProject(graphql, owner, number);

await graphql(
  `mutation($projectId: ID!, $readme: String!) {
    updateProjectV2(input: {
      projectId: $projectId,
      shortDescription: "Dzajcarz — tasks, bugs and research spikes",
      public: false,
      readme: $readme
    }) { projectV2 { id } }
  }`,
  { projectId: project.id, readme: README },
);

await graphql(
  `mutation($projectId: ID!, $repositoryId: ID!) {
    linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
      repository { id }
    }
  }`,
  { projectId: project.id, repositoryId: ids.repository.id },
).catch((error: unknown) => {
  // Only "already linked" is fine; an auth or scope failure must not pass for success.
  if (!/already/i.test((error as Error).message)) throw error;
});

// --- 2. Status columns ----------------------------------------------------------
const wantedStatuses = STATUS_OPTIONS.map((s) => s.name);
if (wantedStatuses.some((s) => !project.statusOptions.has(s))) {
  try {
    await graphql(
      `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id } }
        }
      }`,
      { fieldId: project.statusFieldId, options: STATUS_OPTIONS },
    );
    project = await getProject(graphql, owner, number);
    console.info(`Status options: ${wantedStatuses.join(" → ")}`);
  } catch (error) {
    manual.push(
      `Status field: set options to ${wantedStatuses.join(", ")} (API refused: ${(error as Error).message})`,
    );
  }
}

// --- 3. Custom fields -----------------------------------------------------------
const existingFields = await graphql<{
  node: {
    fields: { nodes: { id: string; name: string; options?: ExistingOption[] }[] };
  };
}>(
  `query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField { options { id name color description } }
          }
        }
      }
    }
  }`,
  { projectId: project.id },
);
const fieldByName = new Map(existingFields.node.fields.nodes.map((f) => [f.name, f]));

/** label → { fieldId, optionId } */
const labelTargets = new Map<string, { fieldId: string; optionId: string }>();

for (const [name, options] of Object.entries(SELECT_FIELDS)) {
  let field = fieldByName.get(name);
  if (!field) {
    const created = await graphql<{
      createProjectV2Field: {
        projectV2Field: { id: string; options: { id: string; name: string }[] };
      };
    }>(
      `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        createProjectV2Field(input: {
          projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options
        }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }
        }
      }`,
      {
        projectId: project.id,
        name,
        options: options.map(({ name, color, description }) => ({ name, color, description })),
      },
    );
    field = { name, ...created.createProjectV2Field.projectV2Field };
    console.info(`Created field ${name}`);
  } else if (options.some((o) => !field?.options?.some((e) => e.name === o.name))) {
    // Keep every existing option (including hand-added ones) with its id so items set to them survive;
    // only the missing ones are appended.
    const existing = field.options ?? [];
    const appended = options
      .filter((o) => !existing.some((e) => e.name === o.name))
      .map(({ name, color, description }) => ({ name, color, description }));
    try {
      const updated = await graphql<{
        updateProjectV2Field: { projectV2Field: { options: { id: string; name: string }[] } };
      }>(
        `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
          updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
            projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } }
          }
        }`,
        {
          fieldId: field.id,
          options: [
            ...existing.map(({ id, name, color, description }) => ({
              id,
              name,
              color,
              description,
            })),
            ...appended,
          ],
        },
      );
      const after = updated.updateProjectV2Field.projectV2Field.options;
      const lost = existing.filter((e) => !after.some((o) => o.id === e.id));
      if (lost.length > 0) {
        console.warn(
          `WARNING: field ${name} lost option ids for ${lost.map((o) => o.name).join(", ")}; items set to them were cleared, run sync-project.ts to restore`,
        );
      }
      field = { ...field, options: after };
      console.info(`Updated options of field ${name}`);
    } catch (error) {
      manual.push(
        `Field ${name}: add options ${appended.map((o) => o.name).join(", ")} (API refused: ${(error as Error).message})`,
      );
    }
  }
  for (const option of options) {
    const optionId = field.options?.find((o) => o.name === option.name)?.id;
    if (optionId) labelTargets.set(option.label, { fieldId: field.id, optionId });
  }
}

if (!fieldByName.has("Sprint")) {
  const iterations = Array.from({ length: SPRINT_COUNT }, (_, i) => {
    const start = new Date(`${SPRINT_START}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + i * SPRINT_DAYS);
    return {
      title: `Sprint ${i + 1}`,
      startDate: start.toISOString().slice(0, 10),
      duration: SPRINT_DAYS,
    };
  });
  try {
    await graphql(
      `mutation($projectId: ID!, $config: ProjectV2IterationFieldConfigurationInput!) {
        createProjectV2Field(input: {
          projectId: $projectId, dataType: ITERATION, name: "Sprint", iterationConfiguration: $config
        }) { projectV2Field { ... on ProjectV2IterationField { id } } }
      }`,
      {
        projectId: project.id,
        config: { startDate: SPRINT_START, duration: SPRINT_DAYS, iterations },
      },
    );
    console.info(
      `Created field Sprint (${SPRINT_COUNT} × ${SPRINT_DAYS} days from ${SPRINT_START})`,
    );
  } catch (error) {
    manual.push(
      `Add an Iteration field "Sprint": ${SPRINT_DAYS}-day sprints starting ${SPRINT_START} (API refused: ${(error as Error).message})`,
    );
  }
}

// --- 4. Issues ------------------------------------------------------------------
const issues = (
  (await gh`gh api --paginate --slurp ${`repos/${owner}/${repo}/issues?state=open&per_page=100`}`.json()) as {
    number: number;
    pull_request?: unknown;
    labels: { name: string }[];
    milestone: { title: string } | null;
  }[][]
).flat();

// Issues whose card already has a Status keep it: a re-run must not drag In Progress or QA back.
const withStatus = new Set<number>();
for (let cursor: string | null = null; ; ) {
  const page: {
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { content: { number?: number } | null; status: { optionId: string } | null }[];
      };
    };
  } = await graphql(
    `query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              content { ... on Issue { number } }
              status: fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { optionId }
              }
            }
          }
        }
      }
    }`,
    { projectId: project.id, cursor },
  );
  for (const item of page.node.items.nodes) {
    if (item.content?.number !== undefined && item.status) withStatus.add(item.content.number);
  }
  if (!page.node.items.pageInfo.hasNextPage) break;
  cursor = page.node.items.pageInfo.endCursor;
}
const todoId = project.statusOptions.get("Todo");
const backlogId = project.statusOptions.get("Backlog");

for (const issue of issues.filter((i) => !i.pull_request)) {
  const itemId = await ensureIssueItem(graphql, project, owner, repo, issue.number);
  if (!itemId) continue;
  const statusId = issue.milestone?.title.startsWith("M1") ? todoId : backlogId;
  if (statusId && !withStatus.has(issue.number))
    await setSingleSelect(graphql, project.id, itemId, project.statusFieldId, statusId);
  for (const label of issue.labels) {
    const target = labelTargets.get(label.name);
    if (target) await setSingleSelect(graphql, project.id, itemId, target.fieldId, target.optionId);
  }
  console.info(`Synced #${issue.number}`);
}

// --- 5. Wire the repository ------------------------------------------------------
await gh`gh variable set PROJECT_NUMBER --body ${String(number)}`;
console.info(`Repository variable PROJECT_NUMBER=${number}`);

manual.push(
  "Views: switch the default view to Board (columns = Status); add a Table view grouped by Assignees and a Roadmap view by Sprint.",
  "Workflows (⋯ → Workflows): enable Auto-add to project (is:issue), Item added → Backlog, Item reopened → Todo, Item closed → Done, Pull request merged → Done, Code changes requested → In Progress, Auto-close issue (Done).",
  "Repository secret PROJECTS_TOKEN: a classic PAT with only the `project` scope; the repository is public, so it needs no `repo` scope (gh secret set PROJECTS_TOKEN).",
);

console.info(
  `\nBoard: ${project.url}\n\nFinish in the browser:\n${manual.map((m) => `  • ${m}`).join("\n")}`,
);
