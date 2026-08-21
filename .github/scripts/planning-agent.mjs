// Planning Agent — runs for every Linear issue currently in STATE_NAME.
//
// Phase 1: ensure a branch exists off BASE_BRANCH for the issue.
// Phase 2: check out THAT branch, run Claude against it, and append the
//          "Plan refinement" appendix to the issue DESCRIPTION (original kept).
//
// Idempotent: an existing branch is not recreated, and an issue whose
// description already carries the analysis marker is not re-analysed.
// Self-healing: if phase 2 failed on an earlier run, the next run retries it
// without redoing phase 1.
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
        labels(first: 10) { nodes { name } }
        project { name }
        parent { identifier title }
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

// Only ever sets `description`. Status, assignee, labels etc. are never passed,
// so this cannot advance the issue's state.
const UPDATE_DESCRIPTION_MUTATION = `
  mutation($id: String!, $description: String!) {
    issueUpdate(id: $id, input: { description: $description }) { success }
  }
`;

const comment = (issueId, body) => linear(COMMENT_MUTATION, { issueId, body });

const setDescription = (id, description) =>
  linear(UPDATE_DESCRIPTION_MUTATION, { id, description });

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

const TYPE_LABELS = ['Bug', 'Feature', 'Improvement', 'Setup'];
const DATA_AREAS = ['Database', 'API'];

function buildPrompt(issue, branch) {
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  const typeLabel = labels.find((l) => TYPE_LABELS.includes(l)) ?? 'unlabelled';
  const areaLabels = labels.filter((l) => !TYPE_LABELS.includes(l));
  const q = (v) => String(v ?? '').replace(/"/g, "'");

  const attrs = [
    `identifier="${q(issue.identifier)}"`,
    `title="${q(issue.title)}"`,
    `type="${typeLabel}"`,
    areaLabels.length ? `areas="${q(areaLabels.join(', '))}"` : null,
    issue.project?.name ? `project="${q(issue.project.name)}"` : null,
    issue.parent ? `parent="${q(issue.parent.identifier)} — ${q(issue.parent.title)}"` : null,
  ].filter(Boolean).join(' ');

  const byType = {
    Bug: [
      'Locate the root cause and cite it with a `file:line` anchor — a plan that fixes a symptom',
      'without naming the cause is not finished. State it so it can be moved into `## Context`.',
      'Step 1 of the plan is a failing regression test reproducing the exact scenario in',
      '`## Problem` (use the production example if the issue gives one); the fix comes after it.',
    ],
    Feature: [
      'Plan unit tests for calculation and business logic, and component tests (Testing Library)',
      'for new UI states. Extend an existing spec in `e2e/` only if this touches a core flow',
      '(auth, shifts, time tracking, payroll).',
    ],
    Improvement: [
      'Establish what the current behaviour is before planning the change, and name the tests',
      'that would catch a regression in it.',
    ],
    Setup: [
      'Tooling/config/infrastructure work. Automated tests may not apply — if not, name the',
      'commands that prove it works.',
    ],
  };
  const guidance = [
    ...(byType[typeLabel] ?? [
      'No type label, so treat this as implementation work: establish current behaviour, then',
      'plan the change, then the tests that prove it.',
    ]),
  ];
  if (areaLabels.some((l) => DATA_AREAS.includes(l))) {
    guidance.push(
      'This touches Database/API: plan RLS tests both ways — the permitted role sees the data,',
      'and a user without the permission gets an error or an empty result. Never plan only the',
      'happy path.'
    );
  }

  return [
    '<role>',
    'You are the Planning Agent for peeepl-dev. You turn a Linear issue into a plan precise enough',
    'that a separate AI coding agent can implement it without re-deriving anything. You do not',
    'write production code and you do not implement the issue.',
    '</role>',
    '',
    '<environment>',
    `Repo checked out at branch "${branch}", cut from "${BASE_BRANCH}". Tools: Read, Grep, Glob (read-only).`,
    'Verification: `npm run lint` · `npm run test:ci` (Vitest + coverage) · `npx playwright test` (e2e).',
    'Fixtures live in `e2e/fixtures`. Tests never touch production data; edge-case data (part-time',
    'contracts, minijob, multi-company users) belongs in fixtures, not inline.',
    '</environment>',
    '',
    `<issue ${attrs}>`,
    issue.description || '(no description provided)',
    '</issue>',
    '',
    '<issue_conventions>',
    'peeepl-dev issues use fixed H2 sections; a section that is absent means "none", not "unknown".',
    '- `## Out of scope` is binding. Never plan work it excludes.',
    '- `## Locked decisions` are settled. Do not reopen them or propose alternatives.',
    '- `## Acceptance criteria` checkboxes are the contract: each must be satisfied by a named',
    '  test. A later stage diffs checkbox text against test names mechanically, so name tests so',
    '  that correspondence is obvious to a script. If the issue has no checkboxes, derive them',
    '  from `## Goal`/`## Problem` and mark each `(proposed)` for a human to confirm.',
    '- An invariant stated in the issue ("a full absence week changes the time account by exactly',
    '  0 h") becomes its own named test. These are what the automation gates on.',
    '- Never plan to rewrite an unrelated test to make it pass. A pre-existing failure on the base',
    '  branch is reported on the issue, not patched here.',
    '</issue_conventions>',
    '',
    '<investigate_before_answering>',
    'Read the code before describing it. Every path, symbol, table, RPC, migration or line number',
    'you cite must come from a file you opened in this session — not from the issue text, not from',
    'naming convention, not from what a repo of this kind usually contains.',
    '',
    'If the issue implies something exists and you cannot find it, say so plainly ("no migration',
    'matching `absences` under `supabase/migrations`"). A named gap helps the next agent; a',
    'confident wrong anchor sends it to the wrong file.',
    '</investigate_before_answering>',
    '',
    '<search_strategy>',
    'Glob the area the issue names, Grep its domain terms, then Read only the files that matter.',
    'Prefer several narrow searches over one broad one. Stop once you can name the files a change',
    'would touch and describe how each behaves today — reading further does not improve the plan.',
    'If the issue is thin, write a shorter honest plan and put the gaps in "Open questions &',
    'risks". Never pad.',
    '</search_strategy>',
    '',
    '<type_guidance>',
    ...guidance,
    '</type_guidance>',
    '',
    '<output_format>',
    'Your output becomes the "🔍 Plan refinement" appendix on the issue. The human-written sections',
    'stay above it, so reference them by name — never restate Goal, Problem, Scope or Acceptance',
    'criteria.',
    '',
    'Begin your reply with "### Technical notes / Code anchors". Emit exactly these five H3',
    'sections in order and nothing else — no preamble, no closing remarks, no H1 or H2 headings.',
    '',
    '### Technical notes / Code anchors',
    'Files, modules, tables, RPCs and migrations this issue touches. Per entry: a `path/file.ts:123`',
    'anchor plus the enclosing symbol name (line numbers drift, names do not), what it does today,',
    'and the pattern the implementer must match. Write it so it could be moved verbatim into the',
    "issue's own `## Technical notes / Code anchors`. End with any gap you found.",
    '',
    '### Integration plan',
    'Numbered steps. Each names the file(s) to touch and the concrete change there — executable by',
    'a coding agent with no prior context and no judgement calls left open. Test steps sit in their',
    'real position in the sequence, not appended at the end.',
    '',
    '### Test plan',
    'Markdown table: `Acceptance criterion | Test name | File`. One row per checkbox. Test names',
    'are the actual names you propose, not descriptions. Use `manual` as the test name where',
    'automation is not possible and say why; if a criterion cannot be met at all, say so in its row',
    'rather than dropping it. Add a final row stating whether a human usability pass is needed',
    'before Ready to ship (issues labelled `Design`, or touching employee-facing mobile flows) or',
    '`n/a`.',
    '',
    '### Assumptions',
    'Defaults you applied where the issue was silent, so a human can correct them before the coding',
    'agent acts. "None." if there are none.',
    '',
    '### Open questions & risks',
    'Real ambiguity, regression risk, dependencies on unfinished work. "None." if there are none —',
    'no filler.',
    '</output_format>',
  ].filter((l) => l !== null).join('\n');
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

  const original = (issue.description || '').trimEnd();

  const section = [
    ANALYSIS_MARKER,
    '## 🔍 Plan refinement _(Planning Agent, automated)_',
    '',
    `Branch \`${branch}\` at commit \`${sha.substring(0, 7)}\`.`,
    RUN_URL ? `[Workflow run](${RUN_URL})` : 'Generated in CI.',
    '',
    parsed.result.trim(),
  ].join('\n');

  // The human-written description is preserved verbatim above the separator.
  const description = original ? `${original}\n\n---\n\n${section}` : section;

  await setDescription(issue.id, description);
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
      const analysed = (issue.description || '').includes(ANALYSIS_MARKER);
      if (analysed) {
        console.log('  description already contains an analysis - skipping.\n');
        continue;
      }

      await analyseIssue(issue);
      console.log('  analysis written to description.\n');
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
