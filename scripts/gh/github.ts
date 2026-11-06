/** Minimal GitHub GraphQL/REST client shared by the project scripts. */

export const STATUS_OPTIONS = [
  { name: "Backlog", color: "GRAY", description: "Not planned for the current sprint" },
  { name: "Todo", color: "BLUE", description: "Planned for the current sprint" },
  { name: "In Progress", color: "YELLOW", description: "Branch pushed, work ongoing" },
  { name: "QA", color: "PURPLE", description: "PR open: code review and manual testing" },
  { name: "Done", color: "GREEN", description: "Merged to the trunk branch" },
] as const;
export type StatusName = (typeof STATUS_OPTIONS)[number]["name"];

export function createGraphql(token: string) {
  return async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) {
      throw new Error(
        body.errors?.map((e) => e.message).join("; ") ?? `GraphQL HTTP ${res.status}`,
      );
    }
    return body.data as T;
  };
}
export type Graphql = ReturnType<typeof createGraphql>;

export interface ProjectInfo {
  id: string;
  url: string;
  statusFieldId: string;
  statusOptions: Map<string, string>;
}

const PROJECT_FIELDS = `
  id
  url
  field(name: "Status") {
    ... on ProjectV2SingleSelectField { id options { id name } }
  }
`;

export async function getProject(
  graphql: Graphql,
  owner: string,
  number: number,
): Promise<ProjectInfo> {
  type Project = {
    id: string;
    url: string;
    field: { id: string; options: { id: string; name: string }[] } | null;
  };
  const data = await graphql<{
    repositoryOwner: { projectV2?: Project | null } | null;
  }>(
    `query($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        ... on User { projectV2(number: $number) { ${PROJECT_FIELDS} } }
        ... on Organization { projectV2(number: $number) { ${PROJECT_FIELDS} } }
      }
    }`,
    { owner, number },
  );
  const project = data.repositoryOwner?.projectV2;
  if (!project?.field)
    throw new Error(`Project #${number} of ${owner} not found or has no Status field`);
  return {
    id: project.id,
    url: project.url,
    statusFieldId: project.field.id,
    statusOptions: new Map(project.field.options.map((o) => [o.name, o.id])),
  };
}

/** Returns the project item for an issue, adding the issue to the project if needed. */
export async function ensureIssueItem(
  graphql: Graphql,
  project: ProjectInfo,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string | undefined> {
  const data = await graphql<{
    repository: {
      issue: {
        id: string;
        projectItems: { nodes: { id: string; project: { id: string } }[] };
      } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          id
          projectItems(first: 20) { nodes { id project { id } } }
        }
      }
    }`,
    { owner, repo, number: issueNumber },
  );
  const issue = data.repository.issue;
  if (!issue) return undefined;

  const existing = issue.projectItems.nodes.find((item) => item.project.id === project.id);
  if (existing) return existing.id;

  const added = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
    }`,
    { projectId: project.id, contentId: issue.id },
  );
  return added.addProjectV2ItemById.item.id;
}

export async function setSingleSelect(
  graphql: Graphql,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, optionId },
  );
}
