# Issue Guts Labels

Every new issue gets one or more `guts: <area>` labels saying which part of
DragonFruit it falls into, so the people who own an area can filter for it. The
labels come from Jev, [TypeSafe's](https://docs.typesafe.ai/api) "System One"
model: a small, fast model that never writes text and only answers typed
questions with probabilities. Classification costs about $0.0001 per issue and
takes under a second.

The name is the point: Jev is a System One model in Kahneman's sense, the fast
intuitive kind, so each label is its gut call on where in the app's guts the
issue lives.

The labels are meant to be fast, not exact. A wrong one costs a click to
remove; that trade is what makes a model this cheap the right tool. To change
the areas or their wording, follow [Retuning Issue Guts](issue-guts-tuning.md).

## The pieces

| File | Role |
| ---- | ---- |
| `.github/guts/areas.json` | The areas: name → description, and optionally the broader area it sits `within`. The only place an area is defined. |
| `.github/guts/classify.mjs` | Fetches an issue, asks Jev, prints the probabilities, picks the labels. |
| `.github/workflows/issue-guts.yml` | Runs the classifier on every new issue, or by hand. |
| `.github/guts/labelled.json` | Hand-labelled issues, the reference the classifier is measured against. |
| `.github/guts/forms.json` | The user reports in `labelled.json` rewritten as if filed with the bug report form, to measure the form path. |
| `.github/guts/evaluate.mjs` | Scores Jev against `labelled.json`. |
| `.github/guts/corrections.mjs` | Finds the labels people changed after the bot. |

## How an issue is classified

`classify` sends one request to `https://api.typesafe.ai/v1/systemone` with:

- **state**: the issue's title and opening comment. Not the later comments, and
  not images, which Jev cannot read. The body is cut at 60,000 characters to fit
  the 32k-token context, and the branch name in DragonFruit's build line
  (`DragonFruit 0.1.15 (beta) — some/branch @ a6deb763b`) is removed first: a
  branch called `slice-baking-crash` reads as a topic and pulled reports towards
  slicing.

  An issue filed with one of the forms in `.github/ISSUE_TEMPLATE` is sent
  differently: `parseForm` splits the body at its `### ` headings into a
  question → answer map, drops the answers that say nothing (`_No response_`,
  "Not printer-related", "Not export-related"), and Jev gets that map in place
  of the body, with a note on how to read it. The note says the reporter's
  "where did it happen" choice is a guess, often incomplete, and that the
  printer and file format fields alone do not make a problem specific to that
  printer or format. Issues are recognised by the same headings the workflow's
  title-prefix step looks for, so a report written by hand, or an old one,
  still goes as a plain body.
- **questions**: one `noul` (yes/no) question per area, with the area's
  description as the "yes" criterion. Each answer is an independent probability,
  so an issue can belong to several areas. A single `choice` question would not
  work: its probabilities add up to 1, so "both slicing and ctb" and "either
  slicing or ctb" would look the same.

`other` is asked differently: is a substantial part of the report outside every
listed area? Its question carries all the other descriptions, since it cannot
judge "outside" without them.

`pickAreas` then keeps every area at or above the threshold (0.7, see
`DEFAULT_THRESHOLD`), and drops a broad area when a narrower one inside it was
also picked. If none reaches it, the issue gets `guts: other`.

### Printer and resin families

Five areas name a family rather than a part of the app: `anycubic`, `elegoo`
(including SDCP, its network protocol), `uniformation`, `athena` (with NanoDLP)
and `sirayatech` (resin profiles). They sit next to the others, so a report
about a wrong Photon Mono 4 profile gets both `printer/material profile` and
`anycubic`.

Almost every report says which printer it was printed on, so each family's
description says it only applies when the problem is specific to those
printers. Measured, that holds: a slicing bug seen on a Saturn 4 Ultra scored
under 0.2 on `elegoo`, and still got no `elegoo` when filed through the bug
form with "ELEGOO" and ".goo" picked in the dropdowns. A family counts as an answer for the fallback too: a
report Jev can only place as "an Anycubic thing" gets `anycubic`, not `other`.

### Narrow areas inside broad ones

An area can declare that it sits `within` another. Today only `lys` does, inside
`file import`: opening a Lychee scene is importing a file, but a `.lys` bug
belongs to whoever owns the LYS plugin, and the generic import label would only
be noise to whoever owns the import path. Jev still answers both questions as it
sees them (it rates `.lys` reports high on `file import`, and rightly), and the
script keeps the narrower label. If `lys` falls below the threshold while
`file import` passes, the issue keeps `file import`, which is still true.

The rule follows the direction a format flows. Third-party formats DragonFruit
only reads (`.lys`, `.chitubox`) sit within `file import`; `.chitubox` has no area
of its own, so it simply is `file import`. Print formats DragonFruit only writes
(`ctb`, `lumen`) are independent of `slicing`: a bug can be in the slice job and
in a format at once. A format that is ever both read and written will need this
revisited. Anyone who wants every import issue can still search for both labels:
`label:"guts: file import","guts: lys"` matches either.

The model is `jev-latest`. The version that answered is printed with every
result; when it changes, the measurements below no longer apply until re-run.

## The workflow

`.github/workflows/issue-guts.yml` runs on `issues: opened`, and on demand
from **Actions → Issue guts → Run workflow** with an issue number. A manual
run is a dry run by default: it shows the probabilities in the run summary and
labels nothing. Like every `workflow_dispatch` workflow, the button only appears
once the file is on the default branch.

Two jobs, so that no job holds both the API key and write access:

- **Classify** has `issues: read` and the `TYPESAFE_API_KEY` secret, and outputs
  the chosen labels.
- **Label** has `issues: write` and no secret. It creates any `guts:` label
  that does not exist yet and adds the chosen ones. It also puts back the
  `[BUG]` or `[FEAT]` prefix on a form issue whose reporter deleted it; being in
  the same job, a failure to classify also leaves the title alone, which makes
  it noticed. A manual run with `dry_run` off does both, so re-running an issue
  whose first run failed catches up on everything.

### Why untrusted text is safe here

Anyone can open an issue, so the text Jev reads is untrusted. Jev cannot act on
it: it has no tools and can only answer the questions asked, each with a number.
The worst a hostile report can do is push a probability, which can only ever
produce a label that `areas.json` defines. The issue text never reaches a shell:
the script reads it from the GitHub API itself.

## Limits worth knowing

- **Answers vary slightly between identical runs.** Re-running the same 20 issues
  moved the probabilities by 0.005 on average and 0.11 at most, so an answer near
  the threshold can flip between runs. The labels are a first pass, not a verdict.
- **The questions say "bug report"** although the workflow also runs on feature
  requests and tasks. It was tuned on bugs only.
- **Only the opening comment counts.** A report whose real subject only emerges
  in the discussion keeps the labels its first message earned.
- **Pull requests are rejected.** The issues API serves them too; `fetchIssue`
  refuses them rather than classifying a PR description as a bug report.

## Measured accuracy

On 2026-10-05, with `jev-1.13.0`, against the 50 most recent bugs at the time:
34 used for tuning the descriptions, 16 held out and only scored. Precision is
the share of labels Jev gave that were right; recall, the share of right labels
it found.

| Set | Round | Threshold | Exact | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- | --- |
| Tuning (34) | first descriptions | 0.7 | 19/34 | 0.73 | 0.77 | 0.75 |
| Tuning (34) | tuned, with families | 0.7 | 23/34 | 0.83 | 0.81 | 0.82 |
| Tuning (34) | with `scene tools` | 0.7 | 27/34 | 0.94 | 0.92 | 0.93 |
| Tuning (34) | with `scene tools` | 0.6 | 21/34 | 0.80 | 0.96 | 0.87 |
| Held out (16) | first descriptions | 0.7 | 11/16 | 0.89 | 0.80 | 0.84 |
| Held out (16) | tuned, with families | 0.7 | 11/16 | 0.89 | 0.81 | 0.85 |
| Held out (16) | with `scene tools` | 0.7 | 11/16 | 0.90 | 0.86 | 0.88 |
| Held out (16) | with `scene tools` | 0.6 | 10/16 | 0.82 | 0.86 | 0.84 |
| Tuning (34) | `infra`, `printer connection`, wider `ui` (2026-10-13) | 0.7 | 28/34 | 0.93 | 0.95 | 0.94 |
| Held out (16) | `infra`, `printer connection`, wider `ui` (2026-10-13) | 0.7 | 10/16 | 0.87 | 0.87 | 0.87 |

With 16 issues one wrong label moves precision or recall by about five points,
so the held-out rows say "no worse", not "better". Most of the misses on the
held-out set are second labels a person would argue about too (`platform` on a
SpaceMouse bug that only happens on macOS); the first area was right in every
case.

`scene tools` came from a dry run over all 226 open issues, which put a quarter
of the feature requests in `other`: half of those asked for things like scaling
to fit the plate or a ruler, which `ui` only half claimed (0.56–0.69). The nine
multi-selection bugs in the tuning set had the same problem. With the new area,
9 of those 20 feature requests found it, and the rest are mostly real `other`
(sign-in, an Android port, a URL handler).

The "after" rows include the printer families. The 50 issues held five family
labels (four `anycubic`, one `athena`), all found with probabilities from 0.85
to 0.97 and no family given where it did not belong. There was no positive
example at all for `elegoo`, `uniformation` or `sirayatech`: for those we only
know they are not handed out wrongly.

### With the issue forms

On 2026-10-13, still `jev-1.13.0`, before any issue had been filed with the
forms. The 28 user reports among the 50 were rewritten into the bug form in
`forms.json`, restating only what each report said; the team's own technical
issues stay as written, since they would not go through the form.

| Set | Bodies | Threshold | Exact | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- | --- |
| User reports (28) | as written | 0.7 | 23/28 | 0.95 | 0.93 | 0.94 |
| User reports (28) | bug form | 0.7 | 23/28 | 1.00 | 0.88 | 0.93 |
| User reports (28) | bug form | 0.6 | 24/28 | 1.00 | 0.90 | 0.95 |
| Tuning (34) | bug form where it applies | 0.7 | 25/34 | 0.92 | 0.88 | 0.90 |
| Held out (16) | bug form where it applies | 0.7 | 11/16 | 0.91 | 0.87 | 0.89 |

The form makes Jev more sure of itself rather than more right: no wrong label
at all on the 28, and the scores barely move between 0.5 and 0.7, but two
second labels are lost because Jev leans on the reporter's area choice (`mesh
repair` on a report filed under "Slicing", `anycubic` on an Anycubic-only
slicing failure). Telling Jev the choice is often incomplete did not bring them
back. The threshold stays at 0.7 until real form issues say otherwise; the drop
on the tuning set is in issues that did not change and sit within 0.05 of the
threshold.

