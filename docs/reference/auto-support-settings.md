# Auto-Support Settings

The gear button on the **Auto Supports** card opens the settings dialog. It is
organized by the question you are asking, so you do not need to know how the
placement pipeline is built:

| Section | Answers |
| --- | --- |
| **Detection** | What counts as a surface needing support, and how close two detections may be before they merge |
| **Distribution** | Where contacts land on a region, and how far a leaf may fan out from its trunk |
| **Density & Sizing** | How many supports, how thick, and which Support Studio preset sizes them |
| **Stability** | How the part is held against toppling and peel |
| **Post-processing** | What happens after placement: how much one trunk may carry, and how completely gaps are filled |
| **Diagnostics** | The debug switches (`Origin Colors`, `No Brace`, `Simplified`) and the `Debug Mode` (`debugMode`) switch that reveals the last run's diagnostics on the floating **Auto Supports** card |
| **Advanced (calibration)** | The sizing constants the engine ships with, framed in the warning tone |

Every section is a card of fields on one scrolling page — there is no tab to
switch to, and the whole policy fits without one. Every field has a unitless label,
a ⓘ with its help text, and its own tooltip on hover. Numbers are typed or stepped
with `LabeledNumberInput`'s own carets rather than dragged on a slider, with each
unit rendered inside the input field (`mm²`, `°`, `%`) and bounds matching
`AUTO_SUPPORT_CONSTRAINTS`. A switch is a pill. **Sizing Tier** at the top of
**Density & Sizing** is a dropdown of your Support Studio presets (`sizingPreset`) —
the tip, shaft and root numbers of the one you pick are what the run sizes with,
so editing that manual preset changes what auto-support prints.

**Edits are staged.** Changing a policy field in the dialog does nothing until you
press **Save** (which keeps the dialog open and flashes `Saved!` for two seconds;
the title bar carries an **X** / Close button, and there is no separate
**Apply**/**Cancel** pair). Selecting a *preset* is the exception, and it is
deliberate: picking a preset is choosing a policy for the next run, so it applies
immediately.

## Presets

A preset is a named set of auto-support settings — the whole run policy: density,
self-support angle, merge radius, fan limits and the sizing tier. Three ship with
the app:

- **Light** — sparse supports, detail sizing.
- **Medium** — balanced supports, structure sizing.
- **Heavy** — dense supports, anchor sizing.

The floating **Auto Supports** card carries the `AutoSupportPresetSelect` dropdown
(offering every built-in and custom preset), the **Auto-Lift** toggle, and
**Run**.

The selector at the top of the dialog shows the preset your settings are; its
menu lists the presets — built-ins first, then your own, each with the sizing tier
it names and whether it is a built-in, the one in use ticked — and carries
**New**, which saves the current settings under a new name and selects it.

Beside the selector:

- **Rename** the selected preset. Refused for the built-ins, whose names are
  translated.
- **Duplicate** it: a copy of its own, which you can rename, edit and save.
- **Export** it to a JSON file, and **Import** one from a file.

The dialog's footer commits:

- **Delete** on the left, in red, greyed out for a built-in (its id defines the
  file format). It asks first. Deleting the preset you are on selects **Medium**,
  so the dialog never ends up without a policy.
- **Reset**: discard the edits made in the dialog and reload the selected preset.
  Available once there is something to discard.
- **Save**: write the settings, and overwrite the selected preset with them when
  it has drifted. **Save** keeps the modal open and flashes `Saved!` for two
  seconds (there is no separate **Apply**/**Cancel** pair). Available once there
  is something to save, and while a **custom** preset is selected: a built-in's
  block is locked and cannot be saved over, so **Duplicate** it first. The
  dialog's title bar carries **X** (**Close**), and Escape and a click outside
  do the same.

While your settings no longer match the selected preset, its name carries a `*`.
Editing a field never rewrites the preset by itself.

The built-in presets cannot be renamed, deleted or saved over: their names are
translated, their ids define the file format, and their blocks are the factory's.
Duplicating one is how you keep a tweaked density under a name of your own.

Files are described in [Auto-Support Preset Format](auto-support-preset-format.md).

### Not the Support Studio presets

Support Studio's presets — the Detail / Structure / Anchor cards you pick when
placing supports by hand — are a **different system**. They describe the geometry
of a *manually placed* support (tip, shaft, roots) and do not carry auto-support
settings; these auto-support presets describe how an automatic run is policed and
carry no geometry. They do not share storage or files — **except** that each
auto-support policy names a Support Studio preset via `sizingPreset`, so editing
the Studio preset referenced by `sizingPreset` directly changes auto-support
tip, shaft, and root sizing. See [Support Placement](../workflows/support-placement.md).

## Advanced (calibration)

**Advanced (calibration)** is the last card, outlined in the warning tone so it
does not read as one more preference. (The **Diagnostics** card above it holds
the debug switches and the `Debug Mode` toggle; when `Debug Mode` (`debugMode`)
is enabled, the last run's diagnostics appear on the floating `AutoSupportPanel`
card rather than inside this dialog.) These six values are not preferences: they are
tuned by hand. They shape the fit rules — a contact tip whose margin is too generous overhangs the feature it lands
on, a member whose ratio is too small reads as a needle beside its host, and a
run-level cap that is too high thickens shafts past what the band intends. They
are stored **per preset**, so a change here belongs to this preset alone.

Each field's tooltip names the value the engine ships with, so you can always
tell what you changed. There is no separate reset for them: the values live on
the preset, so the footer's **Reset** (back to the selected preset) or selecting
a built-in preset are the ways back.

## Related

- [Auto-Support Preset Format](auto-support-preset-format.md) — the export file
- [Support Placement](../workflows/support-placement.md) — placing supports by hand
- [Island Analysis Workflow](../workflows/island-analysis-workflow.md) — finding the surfaces supports go on
