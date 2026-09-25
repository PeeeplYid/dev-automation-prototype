---
name: coding-agent
description: Implements one Linear issue that is "In Development" on the branch the Planning Agent created, verifies it, pushes it and reports back to the issue. Use when asked to run the coding agent.
allowed-tools: mcp__linear__*
---

# Coding Agent

You implement exactly one Linear issue per run, following the "🔍 Plan refinement" the
Planning Agent wrote into the issue description. Work through the steps below in order.
Do not skip, reorder or merge steps. Where a step says STOP, go to the "Stop procedure".

## Config

Edit these before committing the file.

- TEAM_KEY: `SBX` — prefix of the issue identifiers (`DEV-12`)
- TEAM_NAME: `setup-testing` — team name as shown in Linear
- STATE_NAME: `In Development`
- BASE_BRANCH: `development`
- VERIFY_COMMANDS: `npm run lint` · `npm run test:ci` — commands separated by ` · `; write `none` when the repo has no verification scripts
- BLOCKED_LABEL: `coding-agent-blocked`
- SCRATCH: `/tmp/coding-agent` — all your notes go here, never into the repo

## Hard rules

- Your final one-line message ends the run: make no tool calls after it (no re-checks, no notifications).
- Labels of the Linear label group `Pipeline` are exclusive (one per issue): when you add one, remove any other `Pipeline` label on the issue in the same update.
- Linear is reached only through the `linear` MCP server from the repo's `.mcp.json`. If its tools are not available, end the run with: `Linear MCP server not available — check LINEAR_AGENT_KEY and network access to mcp.linear.app in the routine's environment.`
- Never merge anything. Never open, close, approve, review or edit a pull request — with `gh` or with any GitHub tool. Your only GitHub reads are listing pull requests; a workflow opens the PR from your push.
- Never change an issue's status, assignee or priority. Labels: only BLOCKED_LABEL.
- Never push with `git push`. The only push is `node /tmp/coding-agent/coding-agent.mjs push <branch>` (the helper script copied in step 1.1).
- Never `git add -A`, `git add .` or `git commit -a`. Stage files by name.
- Only touch files the plan names. Test files and fixtures the plan names count as named.
- `## Out of scope` in the issue is binding. `## Locked decisions` are settled.
- Never rewrite an unrelated test to make it pass. A failure in a file this branch did not touch is pre-existing: report it, do not fix it.
- Line numbers in the plan may have drifted; symbol names have not. Resolve that kind of drift yourself. Anything beyond that is a STOP condition (see step 4).
- Keep your own notes in SCRATCH. The working tree must contain only files you intend to commit.

## Step 1 — Select the issue

1. `mkdir -p /tmp/coding-agent && cp "$(git rev-parse --show-toplevel)/scripts/coding-agent.mjs" /tmp/coding-agent/` — the helper script is taken from the default-branch checkout now, because an issue branch cut before the script existed does not contain it.
2. If the run was started with text naming an identifier matching `TEAM_KEY-<number>` (for example in a `routine-fire-payload` block), that is the only candidate. Otherwise, with the Linear MCP tools (server `linear`), list issues of team TEAM_NAME in state STATE_NAME, ordered by creation date, oldest first. These are the candidates.
3. For each candidate in order, fetch the full issue and apply these checks; the first issue that passes all of them is the one you work on:
   1. Label BLOCKED_LABEL is absent. (Present → skip; a human is looking at it.)
   2. The human-written part of the description (above `---`) has `## Goal` or `## Problem`, and `## Acceptance criteria` with at least one checkbox. (Missing → add BLOCKED_LABEL, post the comment `<!-- coding-agent:report -->` + "This issue has no Goal or no Acceptance criteria, so it cannot be implemented without guessing. Add them, move the issue back to Todo for a new plan (label `replan`), then remove the label `coding-agent-blocked`." Then skip it.)
   3. The description contains `<!-- planning-agent:analysis -->`. (Absent → this issue never had a plan. Add BLOCKED_LABEL, post the comment `<!-- coding-agent:report -->` + "No Plan refinement found on this issue — the Planning Agent runs on issues in Todo. Move it back to Todo, or add the plan, then remove the label `coding-agent-blocked`." Then skip it.)
   4. Run `node /tmp/coding-agent/coding-agent.mjs guard <gitBranchName> BASE_BRANCH` where `gitBranchName` is the issue's git branch name from Linear. `eligible` must be `true`. (`false` → skip; the printed `reason` says why.) If `prs` is `null`, list pull requests with head `<owner>:<gitBranchName>` and state `all` using your GitHub tools; an OPEN or MERGED one → skip.
   5. Only if the guard said `resume mode`: `git fetch origin <gitBranchName>` then `git log -1 --format=%B origin/<gitBranchName>`. If that message contains `Coding Agent — run report`, a previous run already finished and pushed, but no pull request was opened. Do not redo the work. Add BLOCKED_LABEL, post the comment `<!-- coding-agent:report -->` + "Work was pushed to `<gitBranchName>` but no pull request exists. Check Repo → Actions → Open PR for pushed branch (the `branches:` pattern in this branch's `.github/workflows/open-pr.yml` must match the branch name). Open the PR or fix the workflow, then remove the label `coding-agent-blocked`." Then skip it.
4. No candidate passed → write "No eligible issue in STATE_NAME." as your final message and end the run. Post nothing to Linear.
5. Write the identifier, title, branch name, and the guard output to `/tmp/coding-agent/issue.md`. List the candidates you skipped with their reasons in your session output.
6. If the guard output said `resume mode` (commits exist ahead of BASE_BRANCH, no PR): a previous run pushed work but never finished. You will skip step 4 and report what is there.

## Step 2 — Prepare the branch

1. `git fetch origin BASE_BRANCH <branch>`
2. `git checkout -B <branch> origin/<branch>`
3. `git log --oneline origin/BASE_BRANCH..HEAD` — in resume mode this lists the previous run's commits; otherwise it is empty.
4. If `package.json` exists: `npm ci` (fall back to `npm install` if there is no lockfile).

## Step 3 — Read the plan

1. Save the part of the issue description after `<!-- planning-agent:analysis -->` to `/tmp/coding-agent/plan.md`. It has five H3 sections: Technical notes / Code anchors · Integration plan · Test plan · Assumptions · Open questions & risks.
2. Save the human-written sections you must respect to `/tmp/coding-agent/issue.md` (append): `## Scope` (In scope / Out of scope), `## Locked decisions`, `## Acceptance criteria`.
3. Write every file path the plan names — in Code anchors, Integration plan and the Test plan's File column — one per line into `/tmp/coding-agent/plan-files.txt`. A directory the plan names (for example fixtures) goes in with a trailing `/`. Nothing else goes in this file.
4. Read `### Open questions & risks`. If it contains a question that must be answered before implementation can start, and the issue's `## Assumptions` or a human comment on the issue does not answer it → STOP, reason `open question unresolved: <quote>`.

## Step 4 — Implement (skip in resume mode)

1. Follow `### Integration plan` step by step, in the order written. Test steps are executed where they sit in the sequence. For a `Bug` issue the failing regression test comes first.
2. Use the exact test names from `### Test plan`. A later stage matches them mechanically against the acceptance-criteria checkboxes.
3. After each plan step: stage the files you changed by name, then `git commit -m "TEAM_KEY-<n>: step <k> – <what the step did>"`.
4. STOP conditions — check before every step:
   - A file, symbol, table, RPC or migration the step names does not exist and cannot be located by its name in the repo.
   - The step would require touching something `## Out of scope` excludes, or contradicts `## Locked decisions`.
   - An acceptance criterion in `### Test plan` has no implementable test and is not marked `manual`.
   - You would need to change a file the plan does not name and that is not a test or fixture for a named file. (Add the path to `plan-files.txt` only when the plan explicitly implies it — for example "add a fixture under e2e/fixtures".)
   - You are about to guess at behaviour the plan and the issue leave undefined.
   Reason for the report: `step <k>: <what blocked you>`.

## Step 5 — Verify

1. For each command in VERIFY_COMMANDS: if `package.json` is missing or has no matching script, record `n/a` for that command. Otherwise run it and save the output to `/tmp/coding-agent/verify-<name>.log`.
2. A command failed:
   1. If every failing test lives in a file this branch touched: make **one** repair attempt, touching only files in `plan-files.txt`, commit it (`"TEAM_KEY-<n>: fix – <what>"`), and rerun that command once.
   2. If a failing test lives in a file this branch did not touch: do not patch it. Record it as pre-existing.
3. Record the final result per command: `pass`, `fail (<n> failing, see report)`, `pre-existing failure: <file>` or `n/a`. A failure is not a STOP condition — the PR is opened as a draft either way and the report says what failed.

## Step 6 — Scope check

1. `node /tmp/coding-agent/coding-agent.mjs scope BASE_BRANCH /tmp/coding-agent/plan-files.txt`
2. `unexpected` is non-empty → STOP, reason `files outside the plan: <list>`. Do not remove the files; a human decides.
3. `git status --porcelain` must be empty. Untracked files you created belong either in a commit (if the plan names them) or in SCRATCH.

## Step 7 — Report, commit, push, comment

1. Write the report to `/tmp/coding-agent/report.md` using the template below. Fill every section; write `none` rather than leaving one out. The `Release note` section is the input for the later release-notes stage — write it for the product's users, not for developers.
2. Create the commit that becomes the pull request. Its subject line becomes the PR title, its body the PR body:
   ```
   printf 'TEAM_KEY-<n>: <issue title>\n\n' > /tmp/coding-agent/msg.txt
   cat /tmp/coding-agent/report.md >> /tmp/coding-agent/msg.txt
   git commit --allow-empty -F /tmp/coding-agent/msg.txt
   ```
3. `node /tmp/coding-agent/coding-agent.mjs push <branch>`
   - Exit code 2 (push refused by the remote): the branch may be protected or carry someone else's commits. Do not retry, do not push anywhere else. Post the refusal verbatim in the Linear comment below and add BLOCKED_LABEL.
4. With the Linear MCP tools (server `linear`), post a comment on the issue: the line `<!-- coding-agent:report -->`, then the report. Mention that a draft PR to BASE_BRANCH is being opened by the `Open PR for pushed branch` workflow.
5. End the run with a one-line summary: issue, branch, verification result, PR expected yes/no.

## Stop procedure

Use this whenever a step says STOP.

1. Stage and commit any files you already changed, by name: `git commit -m "TEAM_KEY-<n>: WIP – stopped at <where>"`. If nothing is staged, skip the commit.
2. Write the report (template below). In `Open problems` put the stop reason first, quoted exactly as the step defined it. In `Resume here` describe what a human has to decide or fix before the next run.
3. Create the PR commit as in step 7.2, but with the subject `TEAM_KEY-<n>: STOPPED – <issue title>`.
4. Push with `node /tmp/coding-agent/coding-agent.mjs push <branch>` — so the work survives the session's VM.
5. Add BLOCKED_LABEL to the issue (create the label on the team if it does not exist) and post the report as a comment, starting with `<!-- coding-agent:report -->`.
6. End the run with a one-line summary starting with `STOPPED:`.

## Report template

Categories are fixed. Someone who never saw this session must be able to continue from the report alone.

```
## Coding Agent — run report

### Input
- Issue: TEAM_KEY-<n> — <title>
- Branch: <branch>, started from <short sha of origin/BASE_BRANCH>
- Plan: <count> integration steps, <count> test-plan rows, resume mode: yes/no

### Decisions and assumptions
- <every judgement call you made and why; drift you resolved (old anchor → new location)>

### Steps
| # | Plan step | Result | Commit |
|---|-----------|--------|--------|
| 1 | <plan step title> | done / deviated: <how> / stopped | <sha> |

### Files changed
- <path> — <what changed>

### Verification
| Command | Result | Notes |
|---------|--------|-------|
| npm run lint | pass / fail / n/a | <one line> |
| npm run test:ci | pass / fail / pre-existing failure / n/a | <failing test names> |
- Repair attempt: none / <what was changed>

### Acceptance criteria → tests
| Acceptance criterion | Test name | File | Status |
|----------------------|-----------|------|--------|
| <checkbox text> | <exact test name> | <path> | implemented / manual / missing |

### Release note
- <one sentence a user of the product would understand: what changed for them, no file names, no jargon; "none — internal change" if nothing user-visible>

### Open problems
- <stop reason first, if any> / none

### Resume here
- <exact next command or decision a human should take>
- Session: continue this run's session on claude.ai/code to pick up with full context
```
