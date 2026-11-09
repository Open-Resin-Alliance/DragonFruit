# Retuning Issue Guts

How to add an area, reword one, or notice that the labels have drifted, without
fooling yourself into thinking it got better. What the pieces are and how a
classification works is in [Issue Guts Labels](issue-guts.md).

Jev is not trained on our issues. Everything we can tune is the wording in
`.github/guts/areas.json` and the threshold, so "retraining" means rewording
descriptions until Jev's answers match a person's, and checking that the new
wording also works on issues it was not tuned on.

## When to retune

- **People keep correcting the bot.** Run `corrections.mjs` (below) now and then;
  a correction rate that climbs, or one area that keeps being added or removed by
  hand, is the signal.
- **A `guts:` label nobody defined shows up.** Someone needed an area that
  does not exist. `corrections.mjs` lists these.
- **A part of the app is added, merged or renamed.**
- **The model changes.** `jev-latest` moves; the version is printed with every
  result. Re-run the evaluation when it does, before trusting the old numbers.

## The labelled set

`.github/guts/labelled.json` maps issue numbers to what a person decided:

```json
"673": {
  "title": "Cut Tool Causes Phantom Auto-Supports",
  "split": "train",
  "areas": ["cuts", "autosupports"],
  "note": "Optional: why, when the call was not obvious."
}
```

- **Judge from the title and opening comment only**, which is all Jev sees.
  Knowing how the bug was eventually fixed makes for a fairer label but an unfair
  test.
- **Only add an area you are at least 85 % sure of.** Use `other` the way the
  bot does: when nothing fits, or a substantial part of the report is about
  something no area covers.
- **`split` is fixed for good.** `train` issues are the ones you look at while
  rewording; `holdout` issues are only scored. New issues go to `holdout` when
  their number is divisible by 3 and to `train` otherwise, which keeps about a
  third held out without anyone choosing. Never move an issue to `train` because
  it failed in `holdout`: that is exactly the leak the split exists to prevent.
- **Write a `note` for every close call,** so the next person does not relabel
  it the other way and call that progress.

`.github/guts/forms.json` holds the user reports from before the issue forms,
rewritten as the bug form would have recorded them, keyed by issue number with
one entry per form question. `evaluate.mjs` sends those instead of the original
bodies, so the measurement reflects how issues arrive now. Issues filed with
the form need no entry: their real body is already a form. When rewriting one,
restate only what the report says, and pick the area the reporter would have
picked, not the right label.

## Procedure

All commands run from the repository root and need `GITHUB_TOKEN` (for example
`export GITHUB_TOKEN=$(gh auth token)`) and, when they call Jev,
`TYPESAFE_API_KEY`. A full pass over 50 issues costs under one cent.

### 1. Collect

Bring in what people have corrected since the last pass:

```bash
node .github/guts/corrections.mjs --since 2026-10-01 --emit
```

It prints each issue where a person added or removed a `guts:` label after
the bot, the correction rate, the corrections per area, any label in use that
`areas.json` does not define, and with `--emit` the confirmed issues missing
from `labelled.json`, already in its format. Read them before merging them in:
a person's correction is usually right, not always.

Issues nobody touched are not evidence either way: silence may mean the bot was
right or that nobody looked.

### 2. Measure the baseline

```bash
node .github/guts/evaluate.mjs --split all --save base.json
node .github/guts/evaluate.mjs --split train --run base.json
```

The first command asks Jev about every labelled issue and keeps the answers
(`--bodies original` sends the reports as written instead of their
`forms.json` version, and `--split forms` keeps only the issues that have one);
the second scores only the `train` split from those answers, without calling
Jev again. Do not look at `holdout` yet.

`evaluate.mjs` prints exact matches, precision, recall and F1 for several
thresholds, then every wrong issue with the probability Jev gave, the errors per
area, and the answers so close to the threshold that a re-run may flip them.

### 3. Reword from the train errors

Look for a pattern before touching anything; one odd issue is not a reason to
reword an area. The patterns met so far, and what fixed them:

| Pattern | Example | Fix |
| ------- | ------- | --- |
| An area that only names a concept misses its concrete forms | Multi-selection transforms missed `ui` | List the forms in the description: move, rotate, scale, mirror, copy… |
| A cluster keeps landing just under the threshold in a catch-all area | Transform and selection reports at 0.56–0.69 on `ui` | It is an area of its own: add it (here, `scene tools`) and take its wording out of the catch-all |
| Jev does not know a term belongs to an area | "cone angle" not seen as Support Studio | Name the term in the description |
| Two areas overlap and Jev picks the wrong one | `.chitubox` scenes read as `ctb` | Say in the description which area owns the overlap |
| A catch-all area grabs everything | Any crash went to `platform` | Narrow the wording to what really belongs there |
| `other` fires when it should not | Platform bugs got `other` | `other`'s question must see every description (it does now) |
| Noise in the report reads as a topic | Branch names in the build line | Strip it before sending, in `classify` |

A disagreement that comes from the taxonomy rather than from Jev (should opening
a `.lys` scene also be `file import`?) is a decision for people. Settle it, and
fix `labelled.json` or `areas.json` to match, rather than wording around it.

### 4. Measure the train split again

```bash
node .github/guts/evaluate.mjs --split train --save tuned-train.json
```

Repeat 3 and 4 while it improves, but stop after two or three rounds: past that
you are teaching the descriptions the train issues, not the areas.

### 5. Check the holdout, once

```bash
node .github/guts/evaluate.mjs --split holdout --save tuned-holdout.json
node .github/guts/evaluate.mjs --split holdout --run base.json
```

**Keep the new wording if the holdout F1 did not drop.** Gains on `train` that
do not show on `holdout` are usually the descriptions fitting those particular
issues. A drop means go back to 3 with a different idea, not a closer look at the
holdout issues that failed.

### 6. Decide the threshold

Change `DEFAULT_THRESHOLD` in `classify.mjs` only when `train` and `holdout`
agree on the move. When they disagree, keep the current value. Between equal
F1s, prefer the lower threshold: a missing label hides an issue from the people
who filter for that area, while a spare one costs a click.

### 7. Record it

Commit `areas.json`, `labelled.json` and any threshold change together, and
update the results table in [Issue Guts Labels](issue-guts.md) with
the date and the model version.

## Reading the numbers

- **Answers are not deterministic.** Re-running identical issues moved
  probabilities by 0.005 on average and up to 0.11. Anything flagged as near the
  threshold can land either way.
- **Small sets move in big steps.** With 16 holdout issues, one label is about
  five points of precision or recall. A difference of less than ten points on a
  set that size is not evidence of anything.
- **Watch for clusters.** Several reports of the same bug count as several
  issues and pull the wording towards them.

## Adding, renaming or removing an area

**Adding.** Add the name and description to `areas.json`. If it is a narrower
case of an existing area, say so with `within` (see "Narrow areas inside broad
ones" in [Issue Guts Labels](issue-guts.md)), and label it the same way in
`labelled.json`: the narrow area alone, not both. Then go through
**every** issue in `labelled.json` and decide whether the new area applies, not
just the ones that prompted it: an issue that should carry it but does not is
scored as a miss. Run the procedure from step 2.

**Renaming.** Rename the key in `areas.json` and every use in `labelled.json`,
then rename the label on GitHub so labelled issues follow:

```bash
gh label edit "guts: old name" --name "guts: new name"
```

**Removing.** Remove it from `areas.json` and from `labelled.json`, giving
`other` to the issues left with nothing. Delete or keep the GitHub label as you
see fit; the bot stops adding it either way.

`evaluate.mjs` refuses to run if `labelled.json` names an area `areas.json` does
not have, so a half-done rename fails loudly.
