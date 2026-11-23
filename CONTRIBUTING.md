# Contributing to DragonFruit

Thanks for your interest in contributing. This guide explains how to get a change accepted with as little back-and-forth as possible.

## Talk to us first

Please discuss your change with us on Discord before you start working on it, for any part of the project. A PR that arrives without warning is much harder to review: we may already be working on the same thing, have a different approach in mind, or not want the change at all. A short conversation up front saves you time as well as ours.

Small fixes such as typos, broken links or obvious one-line bugs can go straight to a PR.

## Before you open a PR

- Target the `dev` branch.
- Keep PRs focused: one feature or fix per PR.
- Run the checks locally and make sure they pass:
  - `cargo test --lib` (engine)
  - `npm test`
  - `npm run lint`
- If you added or changed user-facing strings, run `npm run i18n:extract` and say so in the PR description, so reviewers know the `.po` churn is expected.
- Update the docs if behavior or settings change.

## PR descriptions

Say what the change does, why it's needed, and how you tested it. Include as much detail as reviewers need to understand the change.

## Using AI tools

AI tools are welcome for writing code and for finding your way around the codebase. The maintainers use them too. But:

- **You own what you submit.** Before you open a PR, you should understand the change, have checked it against how the surrounding code works, and be able to discuss it yourself.
- **First-time contributors: disclose AI use** in your PR description, and keep `Co-Authored-By` trailers and similar attribution in your commits.
- **Write your own review replies.** AI may help you understand the codebase, but it may not stand in for you when explaining your change to maintainers. Keep replies short and answer the question that was asked. Don't paste AI-generated responses into review threads.
- **Verify AI-produced analysis.** If an AI wrote or produced any analysis you present (benchmarks, scripts and their output, research summaries, data comparisons), check it yourself before you present it as evidence. First-time contributors must also say that it was AI-produced.

This applies to every AI assistant, including Claude, Copilot, ChatGPT, Codex and Cursor.

## Working with the existing code

Changes should fit the project's existing architecture and data formats. Look for an existing pathway before you write a new one. If you think the existing design doesn't fit your change, raise it in the Discord discussion before you write it.

### Performance

Changes to performance-sensitive code, such as the slicing engine, should include benchmarks:

- before and after numbers, measured on the same machine with the same input
- the machine you measured on
- medians over repeated runs, not single runs

Any added cost needs a clear justification. Maintainers may re-check your numbers on their own machines.

### Real-world claims

If a change is justified by how prints come out, calculated or simulated results are not enough. Back it with real prints, and include:

- **A tuned print profile.** Manufacturer settings are a starting point, not a tuned profile.
- **Full test details.** Everything needed to reproduce the test: printer, material, slicer and version or commit, settings, and any post-processing.
- **Measurements you've checked yourself**, with photos where they help. Script measurements must be checked by hand for inconsistencies.
- **A control.** The same test without the change, under the same conditions.

Evidence that can't isolate the effect from other causes will not be accepted as justification, however detailed it is.

## Review

The maintainer responsible for the area reviews the PR. They may ask for changes, more evidence, or a different approach. PRs that don't follow this guide may be closed without further review.

## Getting help

- Discord: discussing changes before you start, questions, and general discussion
- GitHub issues: bug reports, and tracking work that's been agreed on

Thanks for contributing.
