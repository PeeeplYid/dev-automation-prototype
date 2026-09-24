#!/usr/bin/env node
// Coding Agent helper — deterministic checks the skill calls in a fixed order.
//
//   node scripts/coding-agent.mjs guard <branch> <base>
//       Is this issue eligible? Prints JSON:
//       { branchExists, ahead, prs: [{number, state}], eligible, reason }
//       eligible = branch exists on origin AND no OPEN or MERGED PR from it.
//
//   node scripts/coding-agent.mjs scope <base> <plan-files.txt>
//       Which committed files are NOT named in the plan? Prints JSON:
//       { changed: [...], unexpected: [...] }
//
//   node scripts/coding-agent.mjs push <branch>
//       The only way the agent pushes. Refuses protected names, refuses when
//       HEAD is not on <branch>, never forces. Prints the git output.
//
// No dependencies. Needs git and gh on PATH (both are in cloud sessions).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROTECTED = ['main', 'master', 'development', 'develop', 'staging', 'production', 'release'];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function tryRun(cmd, args) {
  try { return run(cmd, args); } catch { return null; }
}
function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(msg, code = 1) { console.error(`coding-agent: ${msg}`); process.exit(code); }

const [, , command, ...rest] = process.argv;

// ------------------------------------------------------------------- guard
function guard(branch, base) {
  if (!branch || !base) fail('usage: guard <branch> <base>');
  const branchExists = tryRun('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]) !== null;
  let ahead = 0;
  if (branchExists) {
    tryRun('git', ['fetch', '--quiet', 'origin', base, branch]);
    ahead = Number(tryRun('git', ['rev-list', '--count', `origin/${base}..origin/${branch}`]) ?? 0);
  }
  // gh is not available in every cloud session. Without it, PR state is reported as
  // unknown (prs: null) and the skill checks it with its GitHub tools instead.
  const raw = tryRun('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '20']);
  const prs = raw === null ? null : JSON.parse(raw);
  const blocking = (prs ?? []).filter((p) => p.state === 'OPEN' || p.state === 'MERGED');
  let eligible = true;
  let reason = prs === null ? 'PR state unknown (no gh) — check open/merged PRs from this branch with the GitHub tools' : 'no PR yet';
  if (!branchExists) { eligible = false; reason = 'branch missing on origin (Planning Agent has not run)'; }
  else if (blocking.length) { eligible = false; reason = `PR #${blocking[0].number} is ${blocking[0].state}`; }
  else if (ahead > 0) { reason = `branch already has ${ahead} commit(s) ahead of ${base}${prs === null ? '; PR state unknown' : ' and no PR'} — resume mode unless a PR exists`; }
  out({ branchExists, ahead, prs, eligible, reason });
}

// ------------------------------------------------------------------- scope
function scope(base, planFile) {
  if (!base || !planFile) fail('usage: scope <base> <plan-files.txt>');
  tryRun('git', ['fetch', '--quiet', 'origin', base]);
  const changed = (tryRun('git', ['diff', '--name-only', `origin/${base}...HEAD`]) ?? '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const allowed = readFileSync(planFile, 'utf8')
    .split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  // A plan entry matches a changed file if equal, or if the entry ends with "/"
  // (directory) and the file is inside it, or if the entry ends with "*" (prefix).
  const matches = (file, entry) =>
    file === entry ||
    (entry.endsWith('/') && file.startsWith(entry)) ||
    (entry.endsWith('*') && file.startsWith(entry.slice(0, -1)));
  const unexpected = changed.filter((f) => !allowed.some((e) => matches(f, e)));
  out({ changed, unexpected });
}

// -------------------------------------------------------------------- push
function push(branch) {
  if (!branch) fail('usage: push <branch>');
  if (PROTECTED.includes(branch)) fail(`refusing to push to protected branch "${branch}"`);
  const head = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head !== branch) fail(`HEAD is on "${head}", expected "${branch}" — not pushing`);
  const dirty = tryRun('git', ['status', '--porcelain']);
  if (dirty) fail(`working tree has uncommitted changes — commit or discard first:\n${dirty}`);
  try {
    // Never --force, never a refspec: exactly the current branch to its own name.
    console.log(run('git', ['push', 'origin', `${branch}:${branch}`], { stdio: ['ignore', 'pipe', 'pipe'] }));
    console.log(`pushed ${branch}`);
  } catch (err) {
    fail(`push refused:\n${String(err.stderr ?? err.message).trim()}`, 2);
  }
}

switch (command) {
  case 'guard': guard(...rest); break;
  case 'scope': scope(...rest); break;
  case 'push': push(...rest); break;
  default: fail('usage: coding-agent.mjs <guard|scope|push> ...');
}
