// For every Linear issue in STATE_NAME, runs Claude against the checked-out repo
// and posts the result as a comment on the issue.
// Idempotent: issues that already carry a MARKER comment are skipped.
// Read-only: Claude gets Read/Grep/Glob only. No commits, no PRs, no status changes.

import { execFileSync } from 'node:child_process';

const {
  LINEAR_API_KEY,
  RUN_URL,
  TEAM_KEY,
  STATE_NAME,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  MAX_TURNS = '20',
} = process.env;

for (const [k, v] of Object.entries({ LINEAR_API_KEY, TEAM_KEY, STATE_NAME })) {
  if (!v) {
    console.error(`Missing required environment variable: ${k}`);
    process.exit(1);
  }
}

const MARKER = '<!-- planning-agent:analysis -->';
const LINEAR_URL = 'https://api.linear.app/graphql';

async function linear(query, variables = {}) {
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Linear rejected the API key (HTTP ${res.status}).`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const ISSUES_QUERY = `
  query($teamKey: String!, $stateName: String!, $after: String) {
    issues(
      filter: {
        team:  { key:  { eq: $teamKey } }
        state: { name: { eq: $stateName } }
      }
      first: 100
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        description
        comments(first: 100) { nodes { body } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COMMENT_MUTATION = `
  mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }
`;

function buildPrompt(issue) {
  return [
    'You are analysing a codebase to prepare work on a tracked issue.',
    'You have read-only access. Do not attempt to modify, create or delete any file.',
    '',
    `## Issue ${issue.identifier}: ${issue.title}`,
    '',
    issue.description || '(no description provided)',
    '',
    '## Your task',
    'Produce a markdown document with exactly these three sections:',
    '',
    '### Codebase analysis',
    'Which parts of this repository are relevant to the issue. Give concrete file paths.',
    'Summarise the current state of those parts, and name the conventions and patterns in use.',
    '',
    '### Integration plan',
    'A concrete, ordered plan for implementing this issue. The reader is another AI coding',
    'agent with no prior context, so be specific: name files to touch and what changes where.',
    '',
    '### Supplementary context',
    'Anything relevant that is not obvious from the issue text alone.',
    '',
    'Output only the markdown document. No preamble, no closing remarks.',
  ].join('\n');
}

function runClaude(prompt) {
  const raw = execFileSync(
    'claude',
    [
      '-p', prompt,
      '--model', CLAUDE_MODEL,
      '--max-turns', MAX_TURNS,
      '--allowedTools', 'Read,Grep,Glob',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'json',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );

  const parsed = JSON.parse(raw);
  if (parsed.is_error) {
    throw new Error(`Claude returned an error: ${parsed.result ?? '(no detail)'}`);
  }
  if (!parsed.result || !parsed.result.trim()) {
    throw new Error('Claude returned an empty result.');
  }
  return parsed;
}

async function main() {
  const issues = [];
  let after = null;
  do {
    const page = await linear(ISSUES_QUERY, { teamKey: TEAM_KEY, stateName: STATE_NAME, after });
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);

  console.log(`Found ${issues.length} issue(s) in "${STATE_NAME}" for team ${TEAM_KEY}.`);

  const failures = [];

  for (const issue of issues) {
    const alreadyAnalysed = issue.comments.nodes.some((c) => c.body.includes(MARKER));
    if (alreadyAnalysed) {
      console.log(`SKIP  ${issue.identifier} — analysis comment already present.`);
      continue;
    }

    try {
      console.log(`RUN   ${issue.identifier} — invoking Claude...`);
      const parsed = runClaude(buildPrompt(issue));

      const cost = parsed.total_cost_usd != null ? ` | cost: $${parsed.total_cost_usd}` : '';
      console.log(`      turns: ${parsed.num_turns ?? '?'}${cost}`);

      const body = [
        MARKER,
        '**Planning Agent** _(automated analysis)_',
        '',
        parsed.result.trim(),
        '',
        '---',
        RUN_URL ? `_[Workflow run](${RUN_URL})_` : '_Generated in CI._',
      ].join('\n');

      await linear(COMMENT_MUTATION, { issueId: issue.id, body });
      console.log(`OK    ${issue.identifier} — analysis posted.`);
    } catch (err) {
      const detail = err.stderr ? `${err.message}\n${err.stderr}` : err.message;
      console.error(`FAIL  ${issue.identifier} — ${detail}`);
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
