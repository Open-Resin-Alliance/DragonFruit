# Printing Preview and Send Workflow

Use Printing mode to inspect generated slice layers and export/send the final print artifact.

## 1) Enter Printing mode

Printing mode is available when printing workspace data exists.

If scene changes invalidate the current slice, DragonFruit can require re-slicing before continuing.

## 2) Scrub layers

Use the vertical layer slider to inspect layers:

- drag upper (and optional lower) thumb
- wheel to nudge layers
- Shift for fine movement during drag
- optionally toggle cross-section rendering mode (`smooth`/`rasterized`)

During scrubbing, DragonFruit can use fast preview rendering paths to keep interaction responsive.

## 3) Review print summary

In the Printing panel, confirm:

- printer profile
- resin profile
- estimated print time
- estimated volume
- generated file name/format/size

## 4) Export or send

Available actions depend on slice intent and connected integrations:

- **Export as file**
- **Send to printer** (with optional target picker)
- **Retry/Cancel** during send operations

If file intent was used, DragonFruit can reveal the saved file location in desktop runtime.

## Practical checks

- Verify key support-heavy layers before sending.
- Re-slice after geometry/support modifications.
- Confirm final file format and target printer compatibility.

## Related workflows

- [Raft and Export](./raft-and-export.md)
- [Island Analysis Workflow](./island-analysis-workflow.md)

![Printing workflow placeholder](../assets/placeholders/workflow-printing-preview-send.png)

> Screenshot placeholder: Printing mode with layer scrub slider and printing action panel.
