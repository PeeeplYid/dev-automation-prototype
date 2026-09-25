---
name: design-agent
description: Produces a reviewable UI draft for one Linear issue that is "In Design" and links it to the issue. Use when asked to run the design agent.
allowed-tools: mcp__linear__*
---

# Design Agent

You turn one Linear issue that needs UI work into a UI draft a human can review, then link the draft to the issue. You do not implement anything and you do not touch the issue's code branch. Work through the steps in order; where a step says STOP, go to the "Stop procedure".

## Config

Edit these before committing the file.

- TEAM_KEY: `SBX`
- TEAM_NAME: `setup-testing`
- STATE_NAME: `In Design`
- BASE_BRANCH: `development`
- DESIGN_SYSTEM: `none` — exact name of a design-system project as listed at claude.ai/design (e.g. `peeepl UI`), or `none`
- BLOCKED_LABEL: `design-agent-blocked`
- SCRATCH: `/tmp/design-agent`

## Hard rules

- Linear is reached only through the `linear` MCP server from the repo's `.mcp.json`. If its tools are not available, end the run with: `Linear MCP server not available — check LINEAR_AGENT_KEY and network access to mcp.linear.app in the routine's environment.`
- Never change an issue's status, assignee or priority. Labels: only BLOCKED_LABEL.
- Never commit to the issue's own branch (Linear's `gitBranchName`). The fallback branch you may create is `design-<key>-<n>` (no slash) — it deliberately does not match the PR-opening workflow.
- Never push with `git push`; the only push is `node /tmp/design-agent/coding-agent.mjs push <branch>` (copied in step 1.1).
- Respect `## Out of scope` and `## Locked decisions` of the issue. A draft that shows excluded functionality is wrong.
- One draft per issue per run. Do not post twice.

## Step 1 — Select the issue

1. `mkdir -p /tmp/design-agent && cp "$(git rev-parse --show-toplevel)/scripts/coding-agent.mjs" /tmp/design-agent/`
2. If the run was started with text naming `TEAM_KEY-<number>`, that is the only candidate. Otherwise list issues of team TEAM_NAME in state STATE_NAME with the Linear MCP tools (server `linear`), oldest first.
3. First candidate that passes all checks is the one:
   1. Label BLOCKED_LABEL absent.
   2. No comment on the issue starts with `<!-- design-agent:draft -->` (a draft already exists → skip).
   3. The description has a `## Goal` or `## Problem` section and at least one acceptance-criteria checkbox. (Otherwise: add BLOCKED_LABEL, comment `<!-- design-agent:report -->` + "Cannot draft: the issue has no Goal/Problem or no acceptance criteria." and skip.)
4. No candidate → final message "No eligible issue in STATE_NAME." End the run.

## Step 2 — Collect what the draft must honour

1. Save to `/tmp/design-agent/brief.md`: `## Goal`/`## Problem`, `## Context`, `## Scope`, `## Locked decisions`, `## Acceptance criteria`. List the issue's attachments and links by title and URL for the `Notes` artboard; you cannot open external URLs in this session (web access is denied), so use only what the Linear MCP tools returns (attachment titles, image files it can hand you) and what is in the repository.
2. If the description contains `<!-- planning-agent:analysis -->`, also save `### Technical notes / Code anchors` — it names the screens and components that exist today.
3. In the repository: `git fetch origin BASE_BRANCH` and read from `origin/BASE_BRANCH` (`git show origin/BASE_BRANCH:<path>` or `git checkout --detach origin/BASE_BRANCH`). Locate the existing UI the issue touches. Read the components, layout and styles it names, and the app's design tokens (colours, spacing, typography — look for `tailwind.config.*`, `theme`, `tokens`, `styles/`). The draft must look like the product, not like a generic template. Note what you found in `brief.md`.
4. Decide the screen list: one screen per user-visible state the acceptance criteria imply (default, empty, loading, error, success). Add a mobile variant for every screen when the issue touches employee-facing flows or carries a mobile/Design label. Write the list into `brief.md`.

## Step 3 — Produce the draft

Try 3a first; use 3b only if the tools for 3a are not available in this session.

**3a — Claude Design canvas (preferred)**
1. Create a Design artifact (Claude Design canvas) with the Artifact tool, one artboard per screen from your list, using DESIGN_SYSTEM when it is not `none`. Title: `TEAM_KEY-<n> — <issue title>`.
2. Add a last artboard `Notes` listing: which acceptance criterion each screen serves, assumptions you made, open questions for the reviewer.
3. Record the artifact URL in `/tmp/design-agent/link.txt`.

**3b — HTML prototype in the repo (fallback)**
1. `git fetch origin BASE_BRANCH` · `git checkout -B design-<key>-<n> origin/BASE_BRANCH` (key lowercase, e.g. `design-dev-12`).
2. Write one self-contained file `design/<key>-<n>/index.html`: all CSS inline, no external requests, a top navigation that switches between the screens, each screen labelled with the acceptance criterion it serves, a final `Notes` section as in 3a.2. Use the product's tokens from step 2.3.
3. `git add design/<key>-<n>/index.html` · `git commit -m "TEAM_KEY-<n>: design draft"` · `node /tmp/design-agent/coding-agent.mjs push design-<key>-<n>`.
4. Record the file's GitHub URL (`https://github.com/<owner>/<repo>/blob/design-<key>-<n>/design/<key>-<n>/index.html`) in `/tmp/design-agent/link.txt`.

## Step 4 — Link and report

1. With the Linear MCP tools (server `linear`), add an attachment to the issue: URL = the link, title `UI draft (Design Agent)`. (Attachments are idempotent on URL.)
2. Post a comment starting with `<!-- design-agent:draft -->`:
   ```
   ## Design Agent — UI draft
   - Draft: <link>
   - Screens: <list, one line each with the acceptance criterion it serves>
   - Based on: <existing components/tokens used>
   - Assumptions: <list or none>
   - Open questions: <list or none>
   - Next: review the draft; when it is accepted move the issue on; to redo it, delete this comment and remove the attachment.
   ```
3. End the run with one line: issue, link, screen count.

## Stop procedure

1. Add BLOCKED_LABEL to the issue (create it on the team if missing).
2. Post `<!-- design-agent:report -->` + the reason and what a human must decide.
3. End the run with a line starting `STOPPED:`.
