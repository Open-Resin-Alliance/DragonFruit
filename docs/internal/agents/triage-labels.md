# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

What kind of issue it is (bug, feature, task) is not a label. Set the issue's **type** instead: the organization defines `Bug`, `Feature` and `Task`. Never add a `bug` label.

Which part of the app it falls into is the `guts: <area>` labels, which a bot adds when the issue is opened (see [Issue Guts Labels](../../dev/issue-guts.md)). They are a fast first guess, so correct them when the report clearly says otherwise: add a missing area, remove a wrong one. Those corrections are what the classifier is retuned from. Only use areas defined in `.github/guts/areas.json`; a new area goes there first, following [Retuning Issue Guts](../../dev/issue-guts-tuning.md).

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
