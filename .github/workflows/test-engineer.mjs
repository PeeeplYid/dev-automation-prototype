// Test Engineer — runs each Release-Candidate issue's test plan against the
// staging environment and reports the result on the issue.
//
// Per run (on push to the staging branch or on demand):
//   1. list issues in STATE_NAME; skip those already reported for this staging commit
//   2. read each issue's "### Test plan" table (Acceptance criterion | Test name | File)
//   3. run Playwright once against STAGING_URL: the e2e files the plans name, or
//      the whole suite when no plan names one (regression run)
//   4. per issue: one comment "<!-- test-engineer:result sha=… -->" with a row per
//      test-plan entry (passed / failed / not found / manual / unit — not run here),
//      and the label FAILED_LABEL added or removed
//   5. exit non-zero if any issue has a failing or missing test, so GitHub notifies
//
// Never changes issue status. Idempotent per (issue, staging commit).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const {
  LINEAR_API_KEY, TEAM_KEY, RUN_URL,
  STATE_NAME = 'Release Candidate',
  STAGING_URL,
  STAGING_SHA,
  E2E_DIR = 'e2e',
  FAILED_LABEL = 'tests-failed',
  PLAYWRIGHT_CMD = 'npx playwright test',
  BASE_URL_VAR = 'BASE_URL', // the env variable your playwright.config reads for use.baseURL
} = process.env;

const ANALYSIS_MARKER = '<!-- planning-agent:analysis -->';
const RESULT_MARKER = '<!-- test-engineer:result';
const LINEAR_URL = 'https://api.linear.app/graphql';

async function linear(query, variables = {}) {
  // Retries transient Linear outages (5xx / non-JSON bodies such as "upstream connect error").
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(LINEAR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Linear rejected the API key (HTTP ${res.status}).`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json || res.status >= 500) {
      if (attempt < 4) { console.warn(`Linear HTTP ${res.status}, not JSON or server error — retry ${attempt}/3 in ${attempt * 5}s`); await new Promise((r) => setTimeout(r, attempt * 5000)); continue; }
      throw new Error(`Linear API unavailable after 4 attempts (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.errors) throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
}

// Comments are fetched by marker (this commit's result) so a long history cannot hide one.
const ISSUES_QUERY = `
  query($teamKey: String!, $stateName: String!, $marker: String!, $after: String) {
    issues(filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }, first: 100, after: $after) {
      nodes {
        id identifier title description
        labels(first: 50) { nodes { id name parent { name } } }
        resultComments: comments(filter: { body: { contains: $marker } }, first: 1) { nodes { body } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const LABEL_QUERY = `
  query($teamKey: String!, $name: String!) {
    issueLabels(filter: { team: { key: { eq: $teamKey } }, name: { eq: $name } }, first: 1) { nodes { id } }
  }`;
const COMMENT_MUTATION = `
  mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
const ADD_LABEL_MUTATION = `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`;
const REMOVE_LABEL_MUTATION = `mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`;

// ---------------------------------------------------------------- parsing
// Rows of the "### Test plan" table inside the Plan refinement appendix.
export function parseTestPlanRows(description) {
  const text = description || '';
  const start = text.indexOf(ANALYSIS_MARKER);
  if (start === -1) return [];
  const appendix = text.slice(start);
  const m = appendix.match(/###\s*Test plan[^\n]*\n([\s\S]*?)(?=\n###\s|\s*$)/i);
  if (!m) return [];
  const rows = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, ''));
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0].replace(/\s/g, '')) || /^acceptance criterion$/i.test(cells[0])) continue;
    rows.push({ criterion: cells[0], test: cells[1], file: cells[2] });
  }
  return rows;
}

// Flatten a Playwright JSON report into [{ file, title, status }].
export function collectSpecs(report) {
  const out = [];
  const walk = (suite, parents) => {
    for (const spec of suite.specs ?? []) {
      const statuses = (spec.tests ?? []).flatMap((t) => (t.results ?? []).map((r) => r.status));
      const status = statuses.length === 0 ? 'skipped'
        : statuses.every((s) => s === 'passed' || s === 'skipped') ? 'passed'
        : statuses.at(-1) === 'passed' ? 'passed' : 'failed';
      out.push({ file: spec.file ?? suite.file ?? '', title: [...parents, spec.title].filter(Boolean).join(' › '), status });
    }
    for (const child of suite.suites ?? []) walk(child, [...parents, child.title].filter((p) => p && !p.includes('.')));
  };
  for (const s of report.suites ?? []) walk(s, []);
  return out;
}

const isManual = (test) => !test || /^(manual|n\/a)$/i.test(test.trim());
const isE2E = (file) => !!file && file !== '-' && (file.startsWith(`${E2E_DIR}/`) || file.startsWith(`./${E2E_DIR}/`));

// Names in the plan are free text ("shifts list shows empty state"); Playwright
// titles are "describe › it". Compare on letters and digits only, both directions.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
export function matchRows(rows, specs, { ran, missingFiles = new Set() } = { ran: true }) {
  return rows.map((row) => {
    if (isManual(row.test)) return { ...row, status: 'manual' };
    if (!isE2E(row.file)) return { ...row, status: 'unit — not run here' };
    if (missingFiles.has(row.file)) return { ...row, status: 'not found (file missing)' };
    if (!ran) return { ...row, status: 'not run' };
    const want = norm(row.test);
    const hit = specs.find((s) => {
      const full = norm(s.title);
      const leaf = norm(s.title.split(' › ').at(-1));
      return full.includes(want) || (leaf.length >= 8 && want.includes(leaf));
    });
    return { ...row, status: hit ? hit.status : 'not found' };
  });
}

// ------------------------------------------------------------------- run
function runPlaywright(files) {
  const [cmd, ...rest] = [...PLAYWRIGHT_CMD.split(' '), ...files, '--reporter=json'];
  const env = { ...process.env, [BASE_URL_VAR]: STAGING_URL, CI: '1' };
  let out;
  try {
    out = execFileSync(cmd, rest, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    out = err.stdout; // playwright exits 1 on failures; the JSON is still on stdout
    if (!out) throw new Error(`Playwright did not produce a report: ${err.message}`);
  }
  const start = out.indexOf('{');
  return JSON.parse(out.slice(start));
}

async function main() {
  for (const [k, v] of Object.entries({ LINEAR_API_KEY, TEAM_KEY, STAGING_URL, STAGING_SHA })) {
    if (!v) throw new Error(`Missing required environment variable: ${k}`);
  }
  const sha = STAGING_SHA.slice(0, 7);
  const marker = `${RESULT_MARKER} sha=${sha}`;
  const issues = [];
  let after = null;
  do {
    const page = await linear(ISSUES_QUERY, { teamKey: TEAM_KEY, stateName: STATE_NAME, marker, after });
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);
  const pending = issues.filter((i) => !i.resultComments.nodes.some((c) => (c.body || '').startsWith(marker)));
  console.log(`${issues.length} issue(s) in "${STATE_NAME}", ${pending.length} not yet tested at ${sha}.`);
  if (pending.length === 0) return;

  const plans = pending.map((i) => ({ issue: i, rows: parseTestPlanRows(i.description) }));
  const named = [...new Set(plans.flatMap((p) => p.rows.filter((r) => !isManual(r.test) && isE2E(r.file)).map((r) => r.file)))];
  const missingFiles = new Set(named.filter((f) => !existsSync(f)));
  const files = named.filter((f) => existsSync(f));
  const haveE2E = existsSync(E2E_DIR);
  let specs = [];
  let ran = false;
  if (!haveE2E) {
    console.log(`No ${E2E_DIR}/ directory in this checkout — nothing to run; rows are reported as "not run".`);
  } else if (named.length && !files.length) {
    console.log(`Every e2e file the plans name is missing (${[...missingFiles].join(', ')}) — not running the whole suite in their place.`);
  } else {
    console.log(files.length ? `Running ${files.length} e2e file(s) named by the plans.` : `No e2e file named by the plans — running the whole ${E2E_DIR} suite as regression.`);
    specs = collectSpecs(runPlaywright(files));
    ran = true;
  }
  const failedInSuite = specs.filter((s) => s.status === 'failed');

  const labelData = await linear(LABEL_QUERY, { teamKey: TEAM_KEY, name: FAILED_LABEL });
  const failedLabelId = labelData.issueLabels.nodes[0]?.id;
  if (!failedLabelId) throw new Error(`Label "${FAILED_LABEL}" does not exist on team ${TEAM_KEY}. Create it in Linear (Team → Labels).`);

  const problems = [];
  for (const { issue, rows } of plans) {
    const results = matchRows(rows, specs, { ran, missingFiles: haveE2E ? missingFiles : new Set() });
    const bad = results.filter((r) => r.status === 'failed' || r.status.startsWith('not found'));
    const verdict = rows.length === 0 ? 'NO TEST PLAN' : !haveE2E ? 'NOT RUN' : bad.length ? 'FAILED' : 'PASSED';
    const table = results.length
      ? ['| Acceptance criterion | Test | Result |', '|---|---|---|', ...results.map((r) => `| ${r.criterion} | ${r.test} | ${r.status} |`)].join('\n')
      : '_No "### Test plan" table found in the Plan refinement._';
    const body = [
      `${marker} -->`,
      `**Test Engineer** _(automated)_ — staging \`${sha}\`: **${verdict}**`, '',
      table, '',
      !haveE2E ? `No \`${E2E_DIR}/\` folder in the repository — no end-to-end tests could run.`
        : failedInSuite.length ? `Suite-wide failures on staging (${failedInSuite.length}): ${failedInSuite.slice(0, 10).map((s) => `\`${s.title}\``).join(', ')}`
        : 'No other failures in the run.',
      RUN_URL ? `\n[Workflow run](${RUN_URL})` : '',
    ].join('\n');
    await linear(COMMENT_MUTATION, { issueId: issue.id, body });
    const hasLabel = issue.labels.nodes.some((l) => l.id === failedLabelId);
    const wantLabel = verdict === 'FAILED' || verdict === 'NO TEST PLAN';
    if (wantLabel && !hasLabel) {
      // Pipeline labels are exclusive (Linear label group "Pipeline"): drop any other one first.
      for (const l of issue.labels.nodes) if (l.parent?.name === 'Pipeline' && l.id !== failedLabelId) await linear(REMOVE_LABEL_MUTATION, { id: issue.id, labelId: l.id });
      await linear(ADD_LABEL_MUTATION, { id: issue.id, labelId: failedLabelId });
    }
    if (!wantLabel && hasLabel) await linear(REMOVE_LABEL_MUTATION, { id: issue.id, labelId: failedLabelId });
    console.log(`  ${issue.identifier}: ${verdict}`);
    if (wantLabel) problems.push(`${issue.identifier}: ${verdict}`);
  }
  if (problems.length) throw new Error(`${problems.length} issue(s) not passing:\n${problems.join('\n')}`);
}

if (process.argv[1] && process.argv[1].endsWith('test-engineer.mjs')) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
