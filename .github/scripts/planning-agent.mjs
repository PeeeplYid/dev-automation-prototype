// Planning Agent — runs for every Linear issue currently in STATE_NAME.
//
// Phase 1: ensure a branch exists off BASE_BRANCH for the issue.
// Phase 2: check out THAT branch and run Claude against it, then post the
//          analysis to the issue.
//
// Idempotent: an existing branch is not recreated, and an issue that already
// carries an analysis comment is not re-analysed. Self-healing: if phase 2
// failed on an earlier run, the next run retries it without redoing phase 1.
//
// Read-only with respect to code: Claude gets Read/Grep/Glob only.
// Never commits, never opens a PR, never changes issue status.

import { execFileSync } from 'node:child_process';

const {
  LINEAR_API_KEY,
  GH_TOKEN,
  REPO,
  RUN_URL,
  TEAM_KEY,
  STATE_NAME,
  BASE_BRANCH,
  CLAUDE_MODEL = 'claude-sonnet-5',
  MAX_TURNS = '20',
} = process.env;

for (const [k, v] of Object.entries({
  LINEAR_API_KEY, GH_TOKEN, REPO, TEAM_KEY, STATE_NAME, BASE_BRANCH,
})) {
  if (!v) {
    console.error(`Missing required environment variable: ${k}`);
    process.exit(1);
  }
}

const BRANCH_MARKER = '<!-- planning-agent:branch -->';
const ANALYSIS_MARKER = '<!-- planning-agent:analysis -->';
const LINEAR_URL = 'https://api.linear.app/graphql';
const GH_API = 'https://api.github.com';

// --------------------------------------------------------------- API helpers

async function linear(query, variables = {}) {
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Linear rejected the API key (HTTP ${res.status}). Check LINEAR_API_KEY and its access to team ${TEAM_KEY}.`
    );
  }

  const json = await res.json();
  if (json.errors) throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function github(path, options = {}) {
  return fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
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
        branchName
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

const comment = (issueId, body) => linear(COMMENT_MUTATION, { issueId, body });

// ------------------------------------------------------------------ git / AI

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Check out the issue's own branch so Claude analyses that tree, not the
// branch the workflow happens to be running from.
function checkoutIssueBranch(branch) {
  git(['fetch', '--depth=1', 'origin', branch]);
  git(['checkout', '-B', branch, 'FETCH_HEAD']);
  return git(['rev-parse', 'HEAD']).trim();
}

function buildPrompt(issue, branch) {
  return [
    'You are analysing a codebase to prepare work on a tracked issue.',
    `The working tree is checked out at branch "${branch}", cut from "${BASE_BRANCH}".`,
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
  if (parsed.is_error) throw new Error(`Claude returned an error: ${parsed.result ?? '(no detail)'}`);
  if (!parsed.result || !parsed.result.trim()) throw new Error('Claude returned an empty result.');
  return parsed;
}

// ---------------------------------------------------------------------- main

async function fetchTodoIssues() {
  const issues = [];
  let after = null;
  do {
    const page = await linear(ISSUES_QUERY, { teamKey: TEAM_KEY, stateName: STATE_NAME, after });
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

async function ensureBranch(issue, baseSha) {
  const branch = issue.branchName;

  const existing = await github(`/repos/${REPO}/git/ref/heads/${branch}`);
  if (existing.ok) {
    console.log(`  branch "${branch}" already exists.`);
    return true;
  }
  if (existing.status !== 404) {
    throw new Error(`Unexpected HTTP ${existing.status} while checking branch "${branch}".`);
  }

  const created = await github(`/repos/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  if (created.status === 422) {
    console.log(`  branch "${branch}" was created concurrently.`);
    return true;
  }
  if (!created.ok) {
    throw new Error(`Failed to create branch "${branch}" (HTTP ${created.status}): ${await created.text()}`);
  }

  console.log(`  created branch "${branch}".`);
  await comment(
    issue.id,
    [
      BRANCH_MARKER,
      '**Planning Agent** _(automated)_',
      '',
      `Branch \`${branch}\` created from \`${BASE_BRANCH}\`.`,
      '',
      RUN_URL ? `_[Workflow run](${RUN_URL})_` : '_Generated in CI._',
    ].join('\n')
  );
  return true;
}

async function analyseIssue(issue) {
  const branch = issue.branchName;

  const sha = checkoutIssueBranch(branch);
  console.log(`  checked out "${branch}" at ${sha.substring(0, 7)}; invoking Claude...`);

  const parsed = runClaude(buildPrompt(issue, branch));
  const cost = parsed.total_cost_usd != null ? ` | cost: $${parsed.total_cost_usd}` : '';
  console.log(`  turns: ${parsed.num_turns ?? '?'}${cost}`);

  await comment(
    issue.id,
    [
      ANALYSIS_MARKER,
      '**Planning Agent** _(automated analysis)_',
      '',
      `Analysed branch \`${branch}\` at commit \`${sha.substring(0, 7)}\`.`,
      '',
      parsed.result.trim(),
      '',
      '---',
      RUN_URL ? `_[Workflow run](${RUN_URL})_` : '_Generated in CI._',
    ].join('\n')
  );
}

async function main() {
  const issues = await fetchTodoIssues();
  console.log(`Found ${issues.length} issue(s) in "${STATE_NAME}" for team ${TEAM_KEY}.\n`);
  if (issues.length === 0) return;

  const baseRes = await github(`/repos/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if (!baseRes.ok) {
    throw new Error(
      `Base branch "${BASE_BRANCH}" not found in ${REPO} (HTTP ${baseRes.status}). Create it before running this workflow.`
    );
  }
  const baseSha = (await baseRes.json()).object.sha;

  const failures = [];

  for (const issue of issues) {
    console.log(`${issue.identifier} — ${issue.title}`);
    try {
      // Phase 1 — branch must exist before anything is analysed.
      await ensureBranch(issue, baseSha);

      // Phase 2 — analyse, unless this issue already has an analysis.
      const analysed = issue.comments.nodes.some((c) => c.body.includes(ANALYSIS_MARKER));
      if (analysed) {
        console.log('  analysis already present - skipping.\n');
        continue;
      }

      await analyseIssue(issue);
      console.log('  analysis posted.\n');
    } catch (err) {
      const detail = err.stderr ? `${err.message}\n${String(err.stderr).trim()}` : err.message;
      console.error(`  FAILED: ${detail}\n`);
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
