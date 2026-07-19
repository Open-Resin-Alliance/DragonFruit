# Auto Supports

Generate a complete, verified support plan in one click. Auto Supports detects every unsupported region, routes collision-checked supports for them, fills steep overhangs at a chosen density, and re-scans the result to prove nothing was missed — all before a single support is committed.

## 1) Open the Islands panel

1. Switch to **Support** mode.
2. Find the **Auto Supports** section in the **Islands** panel.

No manual island scan is required — generation runs its own analysis when needed.

## 2) Pick a density preset

- **Light**: wider contact spacing, only steep overhangs get surface fill, higher thresholds for what counts as a significant region. Fewer supports, easier cleanup.
- **Normal**: balanced spacing and coverage. The default.
- **Heavy**: tight spacing, gentler overhang threshold, more surface fill. For heavy models or resins that need the extra grip.

Presets also scale support strength: regions above a mass threshold automatically get thicker structural supports, while tiny details (claw tips, spikes) get slim detail supports that fit where full-size geometry cannot.

## 3) Generate

Click **Generate Auto Supports**. Progress runs through phases:

- **Scanning**: island analysis of the model.
- **Planning**: raw detections are consolidated into logical unsupported regions; regions resting on the build plate or already covered by existing supports are excluded.
- **Routing**: each planned contact gets a collision-checked support. Regions a plate support cannot reach fall back to on-model struts.
- **Verifying**: the model is re-scanned together with the planned supports; any region the scan still sees gets one repair round, then a final scan confirms.

Generation runs off the main thread — the viewport stays interactive throughout. **Cancel** stops the run at the next opportunity without changing any state.

## 4) Review the preview

Planned supports render as ghost geometry, and the status line summarizes the plan:

- `Previewing N supports (M on-model struts) across K regions.` — the plan, including how many supports anchor on the model instead of the plate.
- `X already covered.` — regions skipped because existing supports or immediate neighbors already serve them.
- `Y regions need manual work (…)` — regions where no safe support could be routed, with the reasons.
- `Verified: no unsupported regions remain.` — the re-scan of model plus supports found nothing left unsupported.

Nothing is committed while previewing. Re-run with a different preset at any time.

## 5) Apply

- **Apply N** commits the whole plan as a single undoable action — one undo removes every generated support.
- **Auto-brace after apply** (on by default) cross-connects the new supports with braces in the same action, stiffening tall columns for printing.
- **Cancel** discards the preview.

Generated supports are ordinary trunks and sticks: edit, move, or delete them individually like any manually placed support.

## Re-running

Auto Supports is aware of existing supports. Running it again after applying (or after placing manual supports) plans only what is still uncovered — it will not stack duplicates onto supported regions.

## Tips

- Rotate the model to minimize overhangs before generating; fewer overhangs means fewer supports.
- Regions reported as needing manual work are usually deep pockets or enclosed geometry. Inspect them and use manual [support placement](support-placement.md) where a support is genuinely possible.
- Use the [Island Analysis workflow](island-analysis-workflow.md) to visualize exactly which regions drove the plan.
