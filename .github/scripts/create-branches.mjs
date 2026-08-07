// Creates one branch off BASE_BRANCH for every Linear issue currently in STATE_NAME.
// Idempotent: a branch that already exists is skipped, so re-runs are harmless.
// Does not modify code, open PRs, or change issue status.

const {
  LINEAR_API_KEY,
  GH_TOKEN,
  REPO,
  RUN_URL,
  TEAM_KEY,
  STATE_NAME,
  BASE_BRANCH,
} = process.env;

for (const [k, v] of Object.entries({ LINEAR_API_KEY, GH_TOKEN, REPO, TEAM_KEY, STATE_NAME, BASE_BRANCH })) {
  if (!v) {
    console.error(`Missing required environment variable: ${k}`);
    process.exit(1);
  }
}

const LINEAR_URL = 'https://api.linear.app/graphql';
const GH_API = 'https://api.github.com';

async function linear(query, variables = {}) {
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Linear rejected the API key (HTTP ${res.status}). Check the LINEAR_API_KEY secret and that the key has access to team ${TEAM_KEY}.`
    );
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function github(path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return res;
}

const ISSUES_QUERY = `
  query($teamKey: String!, $stateName: String!) {
    issues(
      filter: {
        team:  { key:  { eq: $teamKey } }
        state: { name: { eq: $stateName } }
      }
      first: 50
    ) {
      nodes { id identifier title branchName url }
    }
  }
`;

const COMMENT_MUTATION = `
  mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }
`;

async function main() {
  const data = await linear(ISSUES_QUERY, { teamKey: TEAM_KEY, stateName: STATE_NAME });
  const issues = data.issues.nodes;

  console.log(`Found ${issues.length} issue(s) in "${STATE_NAME}" for team ${TEAM_KEY}.`);
  if (issues.length === 0) return;

  // Resolve the base branch once.
  const baseRes = await github(`/repos/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if (!baseRes.ok) {
    throw new Error(
      `Base branch "${BASE_BRANCH}" not found in ${REPO} (HTTP ${baseRes.status}). Create it before running this workflow.`
    );
  }
  const baseSha = (await baseRes.json()).object.sha;

  const failures = [];

  for (const issue of issues) {
    const branch = issue.branchName;

    try {
      const existing = await github(`/repos/${REPO}/git/ref/heads/${branch}`);
      if (existing.ok) {
        console.log(`SKIP  ${issue.identifier} — branch "${branch}" already exists.`);
        continue;
      }
      if (existing.status !== 404) {
        throw new Error(`Unexpected HTTP ${existing.status} while checking branch "${branch}".`);
      }

      const created = await github(`/repos/${REPO}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      });

      if (created.status === 422) {
        console.log(`SKIP  ${issue.identifier} — branch "${branch}" created concurrently.`);
        continue;
      }
      if (!created.ok) {
        throw new Error(`Failed to create branch "${branch}" (HTTP ${created.status}): ${await created.text()}`);
      }

      console.log(`OK    ${issue.identifier} — created "${branch}".`);

      await linear(COMMENT_MUTATION, {
        issueId: issue.id,
        body: [
          '**Planning Agent** _(automated)_',
          '',
          `Branch \`${branch}\` created from \`${BASE_BRANCH}\`.`,
          '',
          `[Workflow run](${RUN_URL})`,
        ].join('\n'),
      });
    } catch (err) {
      console.error(`FAIL  ${issue.identifier} — ${err.message}`);
      failures.push(`${issue.identifier}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} issue(s) failed:\n${failures.join('\n')}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
