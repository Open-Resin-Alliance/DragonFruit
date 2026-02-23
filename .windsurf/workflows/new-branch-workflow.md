---
description: create and start a new task branch with Ty naming
---

# Purpose

Use this workflow whenever starting any new task so work is isolated and easy to review.

## Branch naming rule

Use this format:

- `ty/<task-slug>`

Examples:

- `ty/transforms-debug`
- `ty/import-converter-fix`
- `ty/ui-cleanup`

Important:

- Do not use spaces.
- Do not use brackets like `[Ty]` in branch names.
- Use lowercase and hyphens for readability.

## Step 1: Confirm you are in the correct repo

Run:

- `git remote -v`

You should see the DragonFruit GitHub repo URL.

## Step 2: Update local main before branching

Run:

- `git switch main`
- `git pull origin main`

This ensures your branch starts from the latest team code.

## Step 3: Create your new branch

Run:

- `git switch -c ty/<task-slug>`

Example:

- `git switch -c ty/transforms-debug`

## Step 4: Verify branch

Run:

- `git branch --show-current`

The output should be your new `ty/...` branch.

## Step 5: Start work

Make your code changes only on this branch.

## Quick usage in Cascade

Ask:

- "Run the new branch workflow for task <task-name>"
