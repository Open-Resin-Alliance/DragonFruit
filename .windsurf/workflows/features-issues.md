---
description: create GitHub issues from CLI for feature requests and issue notifications
---
# Purpose
Use this workflow in Windsurf Cascade when you want to create GitHub issues from the command line using GitHub CLI (`gh`).

This covers two common cases:
1. Feature request issues
2. Issue notification / bug-tracking issues
3. TODO / task-tracking issues

## Prerequisites
1. GitHub CLI is installed and available in terminal:
   - `gh --version`
2. You are authenticated:
   - `gh auth login`
   - Preferred protocol: `HTTPS`
3. You are in the target repository folder before creating the issue.

## Step 1: Confirm repository context
Run:
- `gh repo view`

If this fails, either:
- authenticate again with `gh auth login`, or
- specify repository explicitly later with `--repo OWNER/REPO`.

## Step 2: Create a Feature Request issue
Use interactive mode:
- `gh issue create`

When prompted, set:
- Title: must start with `[FEAT] ` followed by clear feature name + outcome
  - Example: `[FEAT] STL Slicing`
- Body: include problem, proposed solution, acceptance criteria
- Labels: include `feature` (or your repo's equivalent)
- Assignee/milestone: set if your team uses them

Recommended body structure:
1. Problem to solve
2. Proposed change
3. Acceptance criteria
4. Notes / dependencies

## Step 3: Create an Issue Notification (bug/problem) issue
Use interactive mode:
- `gh issue create`

When prompted, set:
- Title: must start with `[ISSUE] ` followed by short symptom-focused summary
  - Example: `[ISSUE] Conversion Failing`
- Body: include what happened, impact, and known context
- Labels: include `bug`, `triage`, or your repo equivalent

Recommended body structure:
1. What happened
2. Expected behavior
3. Impact/severity
4. Reproduction details (if known)
5. Logs/screenshots/links

## Step 4: Create a TODO (task-tracking) issue
Use interactive mode:
- `gh issue create`

When prompted, set:
- Title: must start with `[TODO] ` followed by a clear action-oriented task name
  - Example: `[TODO] Refactor support import validation`
- Body: include task goal, scope, and definition of done
- Labels: include `todo`, `task`, or your repo equivalent

Recommended body structure:
1. Task objective
2. Scope / boundaries
3. Definition of done
4. Dependencies / blockers

## Step 5: Optional non-interactive commands (automation)
Feature request example:
- `gh issue create --title "[FEAT] <name>" --body "<details>" --label "feature"`

Issue notification example:
- `gh issue create --title "[ISSUE] <summary>" --body "<details>" --label "bug"`

TODO issue example:
- `gh issue create --title "[TODO] <task>" --body "<details>" --label "todo"`

If not in the repo directory, add:
- `--repo OWNER/REPO`

## Step 6: Verify and share
1. List newly created issues:
   - `gh issue list --limit 10`
2. Open issue in browser if needed:
   - `gh issue view <number> --web`

## Quick usage in Cascade
When you want this process, ask Cascade to:
- "Run the GitHub issue workflow for a feature request"
- "Run the GitHub issue workflow for an issue notification"
- "Run the GitHub issue workflow for a TODO"

Cascade should then guide you through title/body drafting and execute the correct `gh issue create` flow.
