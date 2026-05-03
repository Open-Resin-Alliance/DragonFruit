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

Group changes under conventional commit headers. Each header gets a short bullet list — no paragraphs.

```markdown
**feat: Thing added**
- What it does, one or two lines max

**fix: Thing fixed**
- What was wrong and what changed
```

## General rules

- No emojis anywhere in titles or descriptions
- No em-dashes; use a comma or rewrite the sentence
- No filler phrases like "This PR introduces...", "This commit ensures...", or "...for improved X"
- No closing "Testing" checklists that restate the obvious -- only include testing notes when something non-obvious needs verifying
- Write in plain, direct English -- the same way a developer would write a Slack message about their change
