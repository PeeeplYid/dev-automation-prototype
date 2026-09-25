// Agent dispatcher — starts the Claude Code routines automatically.
//
// Runs every 15 minutes in GitHub Actions. Looks at Linear and GitHub, decides which
// agent has work, and POSTs to that routine's API trigger (/fire) with the issue ID
// or PR number as text. Only fires when there is real work, so the daily routine
// cap is not wasted. Each fire is logged as a Linear comment on the issue
// (`<!-- agent-dispatch:<agent> -->` + session link); a fire is not repeated for
// the same issue and agent within GUARD_MINUTES (a run takes a few minutes).
//
// Env: LINEAR_API_KEY, GH_TOKEN, REPO, TEAM_KEY, BASE_BRANCH,
//      <AGENT>_ROUTINE_URL (variable) + <AGENT>_ROUTINE_TOKEN (secret) for
//      AGENT in DESIGN, CODING, REVIEW, REWORK, RELEASE_NOTES — a missing pair
//      switches that agent off. DRY_RUN=1 only logs. MAX_FIRES caps fires per run.

const E = process.env;
const TEAM_KEY = E.TEAM_KEY;
const BASE = E.BASE_BRANCH || 'development';
const MAX_FIRES = Number(E.MAX_FIRES || 3);
const GUARD_MINUTES = Number(E.GUARD_MINUTES || 60);
const DRY = E.DRY_RUN === '1';
const STATES = { design: 'In Design', coding: 'In Development', rework: 'Rework', ready: 'Ready to ship' };
const L = { designBlocked: 'design-agent-blocked', codingBlocked: 'coding-agent-blocked', needsRework: 'review-agent-needs-rework' };
const PLAN_MARKER = '<!-- planning-agent:analysis -->';
const AGENT_MARKERS = ['<!-- review-agent:', '<!-- rework-agent:', '<!-- coding-agent:', '<!-- test-engineer:', '<!-- release-', '<!-- design-agent:', '<!-- agent-dispatch:'];

for (const k of ['LINEAR_API_KEY', 'GH_TOKEN', 'REPO', 'TEAM_KEY']) if (!E[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const routine = (name) => {
  const url = E[`${name}_ROUTINE_URL`], token = E[`${name}_ROUTINE_TOKEN`];
  return url && token ? { url, token } : null;
};

async function linear(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: E.LINEAR_API_KEY },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if ((!json || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, attempt * 5000)); continue; }
    if (!json) throw new Error(`Linear HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (json.errors) throw new Error(`Linear: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
}
async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${E.REPO}/${path}`, {
    headers: { Authorization: `Bearer ${E.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.json();
}

const ISSUES = `query($teamKey: String!, $states: [String!]) {
  issues(first: 100, filter: { team: { key: { eq: $teamKey } }, or: [
    { state: { name: { in: $states } } },
    { labels: { name: { eq: "${L.needsRework}" } } } ] }) {
    nodes { id identifier title description branchName createdAt
      state { name } labels { nodes { name } } attachments { nodes { title } }
      comments(first: 100) { nodes { body createdAt } } } } }`;
const COMMENT = `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

const has = (issue, label) => issue.labels.nodes.some((l) => l.name === label);
const recentlyFired = (issue, agent) => issue.comments.nodes.some((c) =>
  c.body.includes(`<!-- agent-dispatch:${agent} -->`) && Date.now() - Date.parse(c.createdAt) < GUARD_MINUTES * 60000);
const isAgent = (body) => AGENT_MARKERS.some((m) => (body || '').includes(m));

async function openPrFor(branch) {
  const owner = E.REPO.split('/')[0];
  const prs = await gh(`pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&per_page=10`);
  return prs || [];
}

const plan = [];
async function decide(issues) {
  const key = TEAM_KEY.toLowerCase();
  for (const i of issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const state = i.state.name;
    // Design: In Design, no draft yet, not blocked.
    if (state === STATES.design && !has(i, L.designBlocked)
      && !i.attachments.nodes.some((a) => a.title.startsWith('UI draft'))
      && !i.comments.nodes.some((c) => c.body.includes('<!-- design-agent:draft'))) plan.push({ agent: 'design', issue: i });

    // Coding: In Development, planned, not blocked, branch untouched, no PR.
    if (state === STATES.coding && !has(i, L.codingBlocked) && (i.description || '').includes(PLAN_MARKER) && i.branchName) {
      const cmp = await gh(`compare/${BASE}...${encodeURIComponent(i.branchName)}`);
      const prs = cmp ? await openPrFor(i.branchName) : [];
      if (cmp && cmp.ahead_by === 0 && !prs.some((p) => p.state === 'open' || p.merged_at)) plan.push({ agent: 'coding', issue: i });
    }

    // Rework: state Rework or Review-Agent label; feedback newer than the last rework report.
    if ((state === STATES.rework || has(i, L.needsRework)) && !has(i, L.codingBlocked) && i.branchName) {
      const pr = (await openPrFor(i.branchName)).find((p) => p.state === 'open');
      if (pr) {
        const [comments, inline, reviews] = await Promise.all([
          gh(`issues/${pr.number}/comments?per_page=100`), gh(`pulls/${pr.number}/comments?per_page=100`), gh(`pulls/${pr.number}/reviews?per_page=100`)]);
        const reports = comments.filter((c) => c.body.includes('<!-- rework-agent:report')).map((c) => c.created_at);
        const since = reports.sort().at(-1) || '';
        const feedback = [
          ...comments.filter((c) => !isAgent(c.body) || (has(i, L.needsRework) && c.body.includes('<!-- review-agent:'))).map((c) => c.created_at),
          ...inline.map((c) => c.created_at),
          ...reviews.filter((r) => r.state !== 'PENDING' && r.body !== null).map((r) => r.submitted_at),
        ].filter((t) => t && t > since);
        if (feedback.length) plan.push({ agent: 'rework', issue: i });
      }
    }

    // Release notes: Ready to ship without an entry (one fire covers all issues).
    if (state === STATES.ready && !i.comments.nodes.some((c) => c.body.includes('<!-- release-notes:entry'))
      && !plan.some((p) => p.agent === 'release_notes')) plan.push({ agent: 'release_notes', issue: i, text: '' });
  }

  // Review: open PRs to BASE from issue branches without a review for the current head.
  const prs = await gh(`pulls?state=open&base=${BASE}&per_page=50`);
  for (const pr of prs || []) {
    if (!pr.head.ref.includes(`/${key}-`)) continue;
    const comments = await gh(`issues/${pr.number}/comments?per_page=100`);
    if (comments.some((c) => c.body.includes(`review-agent:review sha=${pr.head.sha}`) || c.body.includes(`review-agent:report sha=${pr.head.sha}`))) continue; // PR comment uses :review, Linear copy :report
    const m = pr.head.ref.match(new RegExp(`/${key}-(\\d+)`));
    const issue = m && issues.find((x) => x.identifier === `${TEAM_KEY}-${m[1]}`);
    if (issue && has(issue, L.needsRework)) continue; // rework pending on this head; review after the push
    plan.push({ agent: 'review', issue, text: String(pr.number) });
  }
}

async function fire(step) {
  const r = routine(step.agent.toUpperCase());
  const label = `${step.agent} ${step.issue?.identifier ?? ''} ${step.text ?? ''}`.trim();
  if (!r) { console.log(`skip ${label}: routine URL/token not configured`); return false; }
  if (step.issue && recentlyFired(step.issue, step.agent)) { console.log(`skip ${label}: fired < ${GUARD_MINUTES} min ago`); return false; }
  const text = step.text ?? step.issue.identifier;
  if (DRY) { console.log(`DRY fire ${label}`); return true; }
  const res = await fetch(r.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.token}`, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) { console.error(`fire ${label} failed: HTTP ${res.status} ${body.slice(0, 200)}`); return false; }
  let url = ''; try { url = JSON.parse(body).claude_code_session_url || ''; } catch {}
  console.log(`fired ${label} → ${url}`);
  if (step.issue) await linear(COMMENT, { issueId: step.issue.id, body: `<!-- agent-dispatch:${step.agent} -->\nDispatcher started the ${step.agent.replace('_', ' ')} agent${step.text ? ` (${step.text})` : ''}: ${url || 'session link unavailable'}` });
  return true;
}

const data = await linear(ISSUES, { teamKey: TEAM_KEY, states: Object.values(STATES) });
await decide(data.issues.nodes);
console.log(`${plan.length} candidate(s): ${plan.map((p) => `${p.agent}:${p.issue?.identifier ?? p.text}`).join(', ') || 'none'}`);
let fired = 0;
for (const step of plan) {
  if (fired >= MAX_FIRES) { console.log(`MAX_FIRES=${MAX_FIRES} reached — rest waits for the next run.`); break; }
  if (await fire(step)) fired++;
}
