#!/usr/bin/env node
// Review Agent helper — the deterministic part of the review.
//
//   node scripts/review-agent.mjs check <base> <rows.json> <plan-files.txt>
//
//   <rows.json>       [{ "criterion": "...", "test": "<test name>|manual", "file": "<path>|-" }]
//                     — the Test plan rows of the issue, as the agent extracted them.
//   <plan-files.txt>  paths the plan names, one per line (dir entries end with "/").
//
//   Prints JSON:
//   {
//     changed:    [files in the PR diff],
//     tests:      [{ criterion, test, file, status: "found"|"missing"|"manual", foundIn }],
//     scope:      { unexpected: [files not named in the plan] },
//     guardrails: [files the PR must never touch, if it did],
//     summary:    { missingTests, unexpectedFiles, guardrailFiles, verdict: "ok"|"needs-rework" }
//   }
//
// No dependencies. Needs git on PATH and the base branch fetched.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Files an implementation PR must never change: the pipeline's own guardrails.
// A change here is reported even if the plan named the file.
const GUARDRAIL_PREFIXES = ['.claude/', '.github/', 'scripts/'];
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(e2e|tests?|__tests__)\//;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryRun(cmd, args) { try { return run(cmd, args); } catch { return null; } }
function fail(msg) { console.error(`review-agent: ${msg}`); process.exit(1); }

const [, , command, base, rowsFile, planFile] = process.argv;
if (command !== 'check' || !base || !rowsFile || !planFile) {
  fail('usage: check <base> <rows.json> <plan-files.txt>');
}

tryRun('git', ['fetch', '--quiet', 'origin', base]);
const changed = (tryRun('git', ['diff', '--name-only', `origin/${base}...HEAD`]) ?? '')
  .split('\n').map((s) => s.trim()).filter(Boolean);

const rows = JSON.parse(readFileSync(rowsFile, 'utf8'));
const allowed = readFileSync(planFile, 'utf8')
  .split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

const matches = (file, entry) =>
  file === entry ||
  (entry.endsWith('/') && file.startsWith(entry)) ||
  (entry.endsWith('*') && file.startsWith(entry.slice(0, -1)));

// --- tests: does each promised test name exist in the PR's test files?
function fileContains(path, needle) {
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(needle);
}
const tests = rows.map((row) => {
  const test = String(row.test ?? '').trim();
  if (!test || /^manual$/i.test(test) || /^n\/a$/i.test(test)) {
    return { ...row, status: 'manual', foundIn: null };
  }
  const named = row.file && row.file !== '-' ? [row.file] : [];
  const candidates = [...named, ...changed.filter((f) => TEST_FILE.test(f) && !named.includes(f))];
  const foundIn = candidates.find((f) => fileContains(f, test)) ?? null;
  return { ...row, status: foundIn ? 'found' : 'missing', foundIn };
});

// --- scope: files the plan did not name
const unexpected = changed.filter((f) => !allowed.some((e) => matches(f, e)));

// --- guardrails: pipeline files touched
const guardrails = changed.filter((f) => GUARDRAIL_PREFIXES.some((p) => f === p || f.startsWith(p)));

const missingTests = tests.filter((t) => t.status === 'missing').length;
const verdict = missingTests === 0 && unexpected.length === 0 && guardrails.length === 0 ? 'ok' : 'needs-rework';

console.log(JSON.stringify({
  changed,
  tests,
  scope: { unexpected },
  guardrails,
  summary: { missingTests, unexpectedFiles: unexpected.length, guardrailFiles: guardrails.length, verdict },
}, null, 2));
