---
description: Guidelines for writing pull request titles, descriptions, and commit messages.
---

# PR Writing Style

Keep PR descriptions clean and human. Avoid patterns that make AI authorship obvious.

## Title format

Use conventional commit prefixes:

```
feat: Short description
fix: Short description
refactor: Short description
chore: Short description
```

## Description format

Prefer a readable GitHub Markdown structure with real section headers and dividers.

```markdown
## Summary

Short plain-English overview of the change and why it exists.

---

## What changed

### Area or feature
- Short bullets that explain the user-visible or reviewer-relevant changes
- Keep bullets concrete and direct

### Another area
- Group related changes together under a clear heading

---

## Notes

- Only include reviewer notes when they are actually useful
```

## General rules

- No emojis anywhere in titles or descriptions
- No em-dashes, use a comma or rewrite the sentence
- No filler phrases like "This PR introduces...", "This commit ensures...", or "...for improved X"
- Use `##` for major sections, `###` for grouped areas, and `---` between major sections when it improves scanability
- Start with a short summary, then group changes by area instead of dumping one long list
- Use short bullets, but complete sentences are fine when they read more naturally
- Prefer reviewer-friendly headings like `Summary`, `What changed`, `Notes`, or `Validation notes` over rigid commit-style labels in the PR body
- No closing "Testing" checklist that restates the obvious, only include validation notes when something non-obvious needs verifying
- Write in plain, direct English, the same way a developer would write a Slack message about their change
