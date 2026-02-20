---
description: commit, push, and open a GitHub pull request from a task branch
---
# Purpose
Use this workflow after you finish a task branch and want to get team review.

## Step 1: Check what changed
Run:
- `git status`

If needed, also run:
- `git diff`

## Step 2: Stage your changes
Run:
- `git add -A`

## Step 3: Create a commit
Run:
- `git commit -m "<clear summary of what changed>"`

Commit message tips:
- Start with a verb (Fix, Add, Refactor, Update).
- Mention the feature/bug clearly.

## Step 4: Push branch to GitHub
Run:
- `git push -u origin <your-branch-name>`

Example:
- `git push -u origin ty/ties-debug`

## Step 5: Open Pull Request
Option A (GitHub web):
1. Go to repository on GitHub.
2. Click "Compare & pull request" for your branch.
3. Set base branch to `main`.
4. Fill title and description.
5. Create PR.

Option B (GitHub CLI):
- `gh pr create --base main --head <your-branch-name> --fill`

## Step 6: Final check
Confirm PR includes:
- What changed
- Why it changed
- How to test
- Any known risks

## Quick usage in Cascade
Ask:
- "Run the pull request workflow for my current branch"
