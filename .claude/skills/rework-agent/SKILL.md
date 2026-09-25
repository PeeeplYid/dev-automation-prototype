---
name: rework-agent
description: Revises the open pull request of one Linear issue in "Rework" or labelled review-agent-needs-rework according to the review feedback, on the same branch, and reports back. Use when asked to run the rework agent.
allowed-tools: mcp__linear__*
---

# Rework Agent

You address review feedback on exactly one issue per run. The issue is in state STATE_NAME, its pull request is open, and humans (or the Review Agent) have left comments. You change only what the feedback asks for, on the existing branch, then push and report. Where a step says STOP, go to the "Stop procedure". Everything the Coding Agent's hard rules forbid is forbidden here too.

## Config

- TEAM_KEY: `SBX`
- TEAM_NAME: `setup-testing`
- STATE_NAME: `Rework`
- BASE_BRANCH: `development`
- VERIFY_COMMANDS: `npm run lint` · `npm run test:ci` — separated by ` · `; `none` if the repo has no verification scripts
- BLOCKED_LABEL: `coding-agent-blocked`
- REVIEW_LABEL: `review-agent-needs-rework` — set by the Review Agent; triggers an automatic rework
- MAX_AUTO_ROUNDS: `2`
- SCRATCH: `/tmp/rework-agent`

## Hard rules

- Labels of the Linear label group `Pipeline` are exclusive (one per issue): when you add one, remove any other `Pipeline` label on the issue in the same update.
- Linear is reached only through the `linear` MCP server from the repo's `.mcp.json`. If its tools are not available, end the run with: `Linear MCP server not available — check LINEAR_AGENT_KEY and network access to mcp.linear.app in the routine's environment.`
- GitHub is reached through your GitHub tools (`gh` may not exist in this session). Never merge, approve, review, edit or close a pull request — with any tool. Your GitHub writes: pushing via `node /tmp/rework-agent/coding-agent.mjs push <branch>` and adding a comment to the pull request.
- Never change an issue's status. Labels: only BLOCKED_LABEL, and removing REVIEW_LABEL after a successful push (step 5).
- Never `git push`, `git add -A`, `git commit -a`. Stage by name.
- Feedback extends the plan: you may touch the files the plan names plus the files a comment names explicitly, plus tests for them. Nothing else.
- A comment asking for something `## Out of scope` excludes, or contradicting `## Locked decisions`, is not implemented — it is answered (step 5) and the issue is stopped for a human.
- Never rewrite an unrelated test to make it pass.

## Step 1 — Select the issue

1. `mkdir -p /tmp/rework-agent && cp "$(git rev-parse --show-toplevel)/scripts/coding-agent.mjs" /tmp/rework-agent/` — taken from the default-branch checkout; the issue branch may predate it.
2. If the run was started with text naming `TEAM_KEY-<number>`, that is the only candidate. Otherwise list issues of team TEAM_NAME in state STATE_NAME, plus issues in any state carrying REVIEW_LABEL, oldest first.
3. First candidate that passes:
   1. BLOCKED_LABEL absent.
   2. With your GitHub tools, list open pull requests with head `<owner>:<gitBranchName>`: exactly one must exist. (None → comment `<!-- rework-agent:report -->` "No open PR for this branch — nothing to rework", add BLOCKED_LABEL, skip.)
   3. Find the newest comment on the issue starting with `<!-- rework-agent:report` or `<!-- coding-agent:report`; note its timestamp as SINCE (none → SINCE empty).
   4. With your GitHub tools, read the pull request's reviews (not pending ones), its inline review comments (path, line, text) and its conversation comments; keep those created after SINCE. Treat a comment starting with `<!-- review-agent:review` as the Review Agent's findings. Save them to `/tmp/rework-agent/feedback.md`. Also collect Linear comments on the issue newer than SINCE that are not automation reports.
   5. If both are empty (no new feedback) → skip; nothing to do.
   6. Issue carries REVIEW_LABEL and already has MAX_AUTO_ROUNDS comments starting `<!-- rework-agent:report` since the last human feedback → replace REVIEW_LABEL with BLOCKED_LABEL, comment `<!-- rework-agent:report -->` "Automatic rework limit reached — the Review Agent still asks for changes. A human decides next.", skip.
4. No candidate → final message "No eligible issue in STATE_NAME." End the run.

## Step 2 — Prepare

1. `git fetch origin BASE_BRANCH <branch>` · `git checkout -B <branch> origin/<branch>` · if `package.json` exists: `npm ci` (no lockfile → `npm install`).
2. Save `## Scope`, `## Locked decisions`, `## Acceptance criteria` and the Plan refinement to `/tmp/rework-agent/issue.md`; the plan's file list to `/tmp/rework-agent/plan-files.txt` (as the Coding Agent does).
3. Turn the feedback into a numbered list in `/tmp/rework-agent/items.md`: one item per distinct request, with source (author, PR review / inline comment with path:line / Linear comment), the exact ask, and your classification: `do` / `already done` / `out of scope` / `unclear`. A Review Agent verdict of NEEDS REWORK contributes its "Findings" as items.
4. Any item is `unclear` in a way you cannot resolve from the issue and plan → STOP with reason `unclear feedback: <quote>`.

## Step 3 — Implement the items

1. Work through the `do` items in order. For each: change the files it names, add or adjust tests where the item changes behaviour, then stage by name and `git commit -m "TEAM_KEY-<n>: rework – <item summary>"`.
2. Append every file you touch that the plan did not name to `/tmp/rework-agent/plan-files.txt` **only if a feedback item names it** — otherwise STOP with reason `feedback needs a file outside plan and feedback: <path>`.

## Step 4 — Verify and scope

1. Run VERIFY_COMMANDS as the Coding Agent does (one repair attempt on files you touched; pre-existing failures reported, not patched).
2. `node /tmp/rework-agent/coding-agent.mjs scope BASE_BRANCH /tmp/rework-agent/plan-files.txt` — `unexpected` non-empty → STOP with the list.
3. `git status --porcelain` must be empty.

## Step 5 — Push and report

1. Write `/tmp/rework-agent/report.md`:
   ```
   <!-- rework-agent:report sha=<new head sha> -->
   ## Rework Agent — <TEAM_KEY-n>

   ### Feedback handled
   | # | Source | Ask | Done | Commit |
   |---|--------|-----|------|--------|
   | 1 | alex, greet.txt:1 | … | yes / no: <reason> | <sha> |

   ### Not implemented
   - <out-of-scope or locked-decision items, with the reason and what the human can decide>

   ### Verification
   | Command | Result |
   |---|---|

   ### Next
   - Push done; the Review Agent re-reviews the new head automatically (dispatcher, ≤ 15 min).
   ```
   (`sha` is filled after the push: `git rev-parse HEAD`.)
2. `node /tmp/rework-agent/coding-agent.mjs push <branch>` — refused (exit 2) → STOP with the refusal text.
3. Fill in the sha, then add the report as a comment on the pull request with your GitHub tools, and post the same text as a Linear comment.
4. Do not reply to or resolve inline review threads; the report table (source → done) is the answer.
   If the issue carries REVIEW_LABEL: remove it now (the next Review Agent run judges the new head).
5. End the run with one line: issue, PR, items done / not done.

## Stop procedure

1. Commit staged work by name as `TEAM_KEY-<n>: rework WIP – stopped at <item>` (skip if nothing staged); push via `node /tmp/rework-agent/coding-agent.mjs push <branch>` so nothing is lost.
2. Write the report with the stop reason first under "Not implemented"; post it on the PR and the issue; add BLOCKED_LABEL.
3. End the run with a line starting `STOPPED:`.
