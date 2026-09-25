// Batch PR keeper — keeps ONE pull request BASE_BRANCH → TARGET_BRANCH open while
// any issue is in STATE_NAME, and links it from those issues. Used twice:
//   Release Candidate: development → staging  (STATE_NAME "Release Candidate")
//   Release:           development → main     (STATE_NAME "Ready to ship")
//
// Per run: list issues in STATE_NAME → if none, exit. Find the open PR
// BASE_BRANCH → TARGET_BRANCH; create it (title "<PR_TITLE> <date>") when
// BASE_BRANCH has commits TARGET_BRANCH lacks, or update its body with the
// current issue list. With NOTES_MARKER set, each issue's latest comment starting
// with that marker (the release-notes entry) is copied into the PR body. On each
// issue: add the PR as an attachment (idempotent on URL) and post one comment
// (PR_MARKER) the first time.
//
// Never merges. Humans merge the PR.
import { execFileSync } from 'node:child_process';

const {
  LINEAR_API_KEY, GH_TOKEN, REPO, RUN_URL, TEAM_KEY,
  STATE_NAME = 'Release Candidate',
  BASE_BRANCH = 'development',
  TARGET_BRANCH = 'staging',
  PR_TITLE = 'Release candidate',
  PR_MARKER_NAME = 'release-candidate:pr',
  NOTES_MARKER = '',
} = process.env;
for (const [k, v] of Object.entries({ LINEAR_API_KEY, GH_TOKEN, REPO, TEAM_KEY })) {
  if (!v) { console.error(`Missing required environment variable: ${k}`); process.exit(1); }
}
const PR_MARKER = `<!-- ${PR_MARKER_NAME} -->`;
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
function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_TOKEN } }).trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

// Comments are fetched by marker so a long comment history cannot hide one.
const ISSUES_QUERY = `
  query($teamKey: String!, $stateName: String!, $prMarker: String!, $notesMarker: String!, $after: String) {
    issues(filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }, first: 100, after: $after) {
      nodes {
        id identifier title url branchName
        prComments: comments(filter: { body: { contains: $prMarker } }, first: 5) { nodes { body } }
        noteComments: comments(filter: { body: { contains: $notesMarker } }, first: 50) { nodes { body createdAt } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const ATTACH_MUTATION = `
  mutation($issueId: String!, $url: String!, $title: String!) {
    attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success }
  }`;
const COMMENT_MUTATION = `
  mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

async function fetchIssues() {
  const issues = []; let after = null;
  const notesMarker = NOTES_MARKER ? `<!-- ${NOTES_MARKER}` : '<!-- none-9f2c -->';
  do {
    const page = await linear(ISSUES_QUERY, { teamKey: TEAM_KEY, stateName: STATE_NAME, prMarker: PR_MARKER, notesMarker, after });
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

function latestNote(issue) {
  if (!NOTES_MARKER) return null;
  const notes = issue.noteComments.nodes
    .filter((c) => (c.body || '').startsWith(`<!-- ${NOTES_MARKER}`))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!notes.length) return null;
  return notes.at(-1).body.split('\n').slice(1).join('\n').trim();
}
function prBody(issues) {
  const rows = issues.map((i) => `| ${i.identifier} | ${i.title} | ${i.url} |`).join('\n');
  const notes = issues.map((i) => ({ i, note: latestNote(i) })).filter((x) => x.note);
  return [
    `${PR_TITLE} — \`${BASE_BRANCH}\` → \`${TARGET_BRANCH}\` for the issues below. Merging is a human decision.`,
    '',
    '| Issue | Title | Linear |', '|---|---|---|', rows,
    ...(notes.length ? ['', '## Release notes', '', ...notes.map(({ i, note }) => `### ${i.identifier} — ${i.title}\n${note}`)] : []),
    '',
    `_Maintained by the "${PR_TITLE}" workflow${RUN_URL ? ` — [last run](${RUN_URL})` : ''}. Do not edit by hand; it is regenerated._`,
  ].join('\n');
}

async function main() {
  const issues = await fetchIssues();
  console.log(`Found ${issues.length} issue(s) in "${STATE_NAME}".`);
  if (issues.length === 0) return;

  const existing = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--base', TARGET_BRANCH, '--head', BASE_BRANCH, '--state', 'open', '--json', 'number,url']));
  let pr;
  if (existing.length > 0) {
    pr = existing[0];
    gh(['pr', 'edit', String(pr.number), '--repo', REPO, '--body', prBody(issues)]);
    console.log(`Updated PR #${pr.number} (${pr.url}).`);
  } else {
    const cmp = JSON.parse(gh(['api', `repos/${REPO}/compare/${TARGET_BRANCH}...${BASE_BRANCH}`, '--jq', '{ahead_by, status}']));
    if (!cmp.ahead_by) {
      console.log(`"${BASE_BRANCH}" has no commits that "${TARGET_BRANCH}" lacks — no PR to open yet. Issues stay unlinked until there is something to release.`);
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const out = gh(['pr', 'create', '--repo', REPO, '--base', TARGET_BRANCH, '--head', BASE_BRANCH,
      '--title', `${PR_TITLE} ${date}`, '--body', prBody(issues)]);
    const m = out.match(/https?:\/\/\S+\/pull\/(\d+)\s*$/m);
    if (!m) throw new Error(`Could not read the PR URL from gh output:\n${out}`);
    pr = { url: m[0].trim(), number: Number(m[1]) };
    console.log(`Opened PR #${pr.number} (${pr.url}).`);
  }

  const failures = [];
  for (const issue of issues) {
    try {
      await linear(ATTACH_MUTATION, { issueId: issue.id, url: pr.url, title: `${PR_TITLE} PR #${pr.number}` });
      const already = issue.prComments.nodes.some((c) => (c.body || '').startsWith(PR_MARKER));
      if (!already) {
        await linear(COMMENT_MUTATION, { issueId: issue.id, body: [
          PR_MARKER, `**${PR_TITLE}** _(automated)_`, '',
          `Included in pull request ${pr.url} (\`${BASE_BRANCH}\` → \`${TARGET_BRANCH}\`).`,
        ].join('\n') });
      }
      console.log(`  ${issue.identifier}: linked${already ? '' : ' + commented'}.`);
    } catch (err) {
      console.error(`  ${issue.identifier} FAILED: ${err.message}`);
      failures.push(`${issue.identifier}: ${err.message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} issue(s) failed:\n${failures.join('\n')}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
