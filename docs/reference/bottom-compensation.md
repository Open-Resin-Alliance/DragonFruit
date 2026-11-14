# Bottom Compensation

The first layers of a print get long exposures so they stick to the build
plate. That extra light spreads past every edge that touches the plate, so the
bottom of a part comes out wider than designed and its holes come out smaller:
the "elephant's foot". Bottom compensation moves those edges back.

## Where to set it

It is part of the material profile. Open the printer's settings, edit (or add) a
material, and find **Bottom Compensation**: a card in the material editor, or
its own **Compensation** tab when the printer's file format brings its own
material editor (Elegoo `.goo` and `.ctb` printers, for example). The values are
saved with the material, so every slice with that material uses them.

## The two settings

| Setting | What it moves | Negative | Positive |
| --- | --- | --- | --- |
| **Bottom outline compensation (mm)** | The outer edges of each part | Removes material: outlines shrink | Adds material: outlines grow |
| **Bottom hole compensation (mm)** | The edges of holes | Removes material: holes open | Adds material: holes close |

- To fix elephant's foot, both are usually **negative**: the outline setting
  pulls the flared outer edge in, the hole setting opens up holes that closed.
- An island standing inside a hole (a peg in a ring, say) counts as an outline
  and moves with the outline setting.
- The two settings are independent. Either can be `0`, and `0` for both turns
  bottom compensation off, which is the default for every material.
- Values run from -2 to 2 mm in 0.01 mm steps. The distance is measured in
  millimetres on the plate, on both axes, whatever the printer's pixel size.

## Which layers it changes

Bottom compensation works on the **bottom layers and the transition layers** of
the material, counted from the build plate. **Fade through transition layers**
(on by default) decides how:

- **On:** the bottom layers get the full compensation. The transition layers,
  whose exposure steps down from the bottom exposure to the normal one, get a
  smaller share on each layer in equal steps, in step with the exposure, so the
  last transition layer (already at the normal exposure) gets none. With 5
  bottom layers and 3 transition layers and an outline compensation of -0.3 mm,
  layers 1-5 get -0.3 mm, layers 6 and 7 get -0.2 and -0.1 mm, and layer 8
  onwards is left alone.
- **Off:** the bottom and transition layers all get the full compensation, and
  it stops after the last transition layer. The same material is compensated by
  -0.2 mm on its first 8 layers.

Formats without transition layers are compensated on the bottom layers only, so
the option makes no difference there.

The change is made to each layer image before anti-aliasing, so anti-aliased
edges follow the compensated outline.

## Finding a value

Print a small test part with a known outer size and hole size and measure it
across its bottom few layers. Each setting moves every edge by its value, so a
width changes by twice the value (one edge on each side): if the outline came
out 0.2 mm too wide, set the outline compensation to -0.1; if a hole came out
0.1 mm too small, set the hole compensation to -0.05. Re-print and re-measure.

## Related pages

- [Printing Preview and Send](../workflows/printing-preview-and-send.md)
- [CLI reference](cli.md) (`slice run` flags and `scene slice`)
