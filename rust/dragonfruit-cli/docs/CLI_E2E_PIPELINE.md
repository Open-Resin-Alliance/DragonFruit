# End-to-End CLI Pipeline Report

Full pipeline demonstration using both CLI tools on `lilith-lilith-part1.stl` (957K triangles, 67mm tall).

## Pipeline Flow

```
TS CLI: scene create → add-model → rotate 15° → place-on-platform
     → duplicate ×2 → arrange (SAT nesting)
                                    │
Rust CLI: island full ─────────────┤  (detect unsupported regions)
                                    │
TS CLI: add supports (2 trunks, knots, branch, leaf, brace, twig)
     → update trunk diameter → group models
     → scene slice ────────────────┤
                                    │
Rust CLI: slice run ───────────────┘  (1311 layers, 59 layers/s)
     → preview-layer (300, 800)
     → export-stl → export-3mf
     → print save
```

## Step 1: Create scene

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene create --o /tmp/pipeline/scene.voxl
```
```
scene create: /tmp/pipeline/scene.voxl
  [scene create] 4.34ms
```

## Step 2: Add model

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene add-model /tmp/pipeline/scene.voxl \
  --mesh ~/Downloads/lilith-lilith-part1.stl --name "Lilith"
```
```
add-model: 'Lilith' id=d0e4e837-b21a-4585-8953-ef7eac1928fe
  [scene add-model] 6.64ms
```

## Step 3: Rotate 15° around X axis + place on platform

```bash
# Rotate (0.2618 rad = 15°)
npx tsx scripts/dragonfruit-ts-cli.ts scene transform-model /tmp/pipeline/scene.voxl \
  --id $MID --rotate 0.2618,0,0

# Auto-place on platform (adjusts Z so model sits on build plate)
npx tsx scripts/dragonfruit-ts-cli.ts scene place-on-platform /tmp/pipeline/scene.voxl \
  --id $MID --mesh-dir ~/Downloads
```
```
transform-model: d0e4e837...
  [scene transform-model] 5.22ms
place-on-platform: d0e4e837... z=0.00 -> 0.00 (mesh minZ=0.00)
  [scene place-on-platform] 167.35ms
```

## Step 4: Duplicate + auto-arrange

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene duplicate /tmp/pipeline/scene.voxl \
  --id $MID --count 2 --offset 0,0,0

npx tsx scripts/dragonfruit-ts-cli.ts scene arrange /tmp/pipeline/scene.voxl \
  --mesh-dir ~/Downloads --spacing 5 --build-width-mm 218 --build-depth-mm 122
```
```
duplicate: d0e4e837... x2 -> 9ca6ffd5..., a2ab8be8...
  [scene duplicate] 5.48ms
arrange: 3 models on 218x122mm plate (anchor=center, spacing=5mm)
  Lilith: (-52.5, 0.7)
  Lilith (1): (0.0, 0.7)
  Lilith (2): (52.5, 0.7)
  [scene arrange] 635.05ms
```

## Step 5: Island detection (Rust)

```bash
dragonfruit-cli island full ~/Downloads/lilith-lilith-part1.stl \
  -o /tmp/pipeline/islands --px-mm 0.1 --layer-height 0.05 --min-area 1.0 --json
```
```
642 total, 30 significant (>1mm²)
raster=1678ms scan=2679ms

Top 5 islands:
  id= 55 L483-549  area=4105.0mm²  centroid=(256,129,503)
  id= 18 L283-487  area=2747.4mm²  centroid=(254,116,314)
  id= 61 L543-715  area=2459.8mm²  centroid=(259,130,559)
  id=130 L916-989  area=1695.2mm²  centroid=(281,122,949)
  id= 60 L536-801  area= 892.0mm²  centroid=(278,110,721)
```

## Step 6: Add supports at island locations (TS)

```bash
# Trunk 1 near island 55
TID1=$(npx tsx scripts/dragonfruit-ts-cli.ts support add-trunk /tmp/pipeline/scene.voxl \
  --model-id $MID --position 5,3,0 --diameter 2.0 --json | jq -r '.trunk_id')

KID1=$(npx tsx scripts/dragonfruit-ts-cli.ts support add-knot /tmp/pipeline/scene.voxl \
  --parent-shaft-id $TID1 --position 5,3,25 --t 0.5 --json | jq -r '.knot_id')

# Trunk 2 near island 18
TID2=$(npx tsx scripts/dragonfruit-ts-cli.ts support add-trunk /tmp/pipeline/scene.voxl \
  --model-id $MID --position -5,-2,0 --diameter 2.0 --json | jq -r '.trunk_id')

KID2=$(npx tsx scripts/dragonfruit-ts-cli.ts support add-knot /tmp/pipeline/scene.voxl \
  --parent-shaft-id $TID2 --position -5,-2,20 --t 0.4 --json | jq -r '.knot_id')

# Branch + leaf on trunk 1
npx tsx scripts/dragonfruit-ts-cli.ts support add-branch /tmp/pipeline/scene.voxl \
  --model-id $MID --parent-knot-id $KID1 --diameter 1.0

npx tsx scripts/dragonfruit-ts-cli.ts support add-leaf /tmp/pipeline/scene.voxl \
  --model-id $MID --parent-knot-id $KID1 --contact 8,5,40 --tip-diameter 0.3

# Brace between trunks
npx tsx scripts/dragonfruit-ts-cli.ts support add-brace /tmp/pipeline/scene.voxl \
  --model-id $MID --start-knot $KID1 --end-knot $KID2 --diameter 0.5

# Twig (model-to-model contact)
npx tsx scripts/dragonfruit-ts-cli.ts support add-twig /tmp/pipeline/scene.voxl \
  --model-id $MID --contact-a 10,0,15 --contact-b 10,0,35
```

## Step 7: Update support

```bash
npx tsx scripts/dragonfruit-ts-cli.ts support update /tmp/pipeline/scene.voxl \
  --id $TID1 --diameter 3.0
```
```
update: 4662f42b...
  [support update] 7.38ms
```

## Step 8: Group models

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene group /tmp/pipeline/scene.voxl \
  --ids $MID,$MID2 --name "Print Batch"
```
```
group: a2a7951e... 'Print Batch' with 2 models
  [scene group] 8.03ms
```

## Step 9: Scene summary

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene list-models /tmp/pipeline/scene.voxl
npx tsx scripts/dragonfruit-ts-cli.ts support list /tmp/pipeline/scene.voxl
npx tsx scripts/dragonfruit-ts-cli.ts scene list-groups /tmp/pipeline/scene.voxl
```
```
3 models:
  d0e4e837... 'Lilith'     pos=(-52.5,0.7,0.0)
  9ca6ffd5... 'Lilith (1)' pos=(0.0,0.7,0.0)
  a2ab8be8... 'Lilith (2)' pos=(52.5,0.7,0.0)

9 support elements:
  2 roots, 2 trunks, 1 branches
  1 leaves, 1 braces, 2 knots

1 groups:
  a2a7951e... 'Print Batch' [d0e4e837..., 9ca6ffd5...]
```

## Step 10: Slice scene (TS merges + Rust slices)

```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene slice /tmp/pipeline/scene.voxl \
  --o /tmp/pipeline/print.nanodlp --mesh-dir ~/Downloads \
  --build-width-mm 218 --build-depth-mm 122
```
```
scene slice: 3 visible models
  loading Lilith: lilith-lilith-part1.stl
    transform: pos=(-52.5,0.7,0.0) rot=(0.262,0.000,0.000) scale=(1,1,1)
  loading Lilith (1): lilith-lilith-part1.stl
    transform: pos=(0.0,0.7,0.0) rot=(0.262,0.000,0.000) scale=(1,1,1)
  loading Lilith (2): lilith-lilith-part1.stl
    transform: pos=(52.5,0.7,0.0) rot=(0.262,0.000,0.000) scale=(1,1,1)
  merged: 2873424 triangles

Slice result:
  layers: 1311
  total_s: 22.06
  layers_per_second: 59.4
  resolution: 11400x6400 px
  [scene slice] 23398ms
```

## Step 11: Extract layer previews (Rust)

```bash
dragonfruit-cli slice preview-layer /tmp/pipeline/print.nanodlp --layer 300 -o layer300.png
dragonfruit-cli slice preview-layer /tmp/pipeline/print.nanodlp --layer 800 -o layer800.png
```
```
extract: layer 300 (87454 bytes)   [slice preview-layer] 24.3ms
extract: layer 800 (70944 bytes)   [slice preview-layer] 24.8ms
```

Layer 300: three 15°-rotated busts, full torso cross-sections.
Layer 800: near the tips of the tilted models, tiny cross-sections.

## Step 12: Export merged scene (TS + Rust)

```bash
# TS merges scene → Rust writes STL
npx tsx scripts/dragonfruit-ts-cli.ts scene export-stl /tmp/pipeline/scene.voxl \
  --o /tmp/pipeline/merged.stl --mesh-dir ~/Downloads

# Rust reads STL → writes 3MF
dragonfruit-cli mesh read-stl /tmp/pipeline/merged.stl -o /tmp/pipeline/mesh
dragonfruit-cli mesh export-3mf -i /tmp/pipeline/mesh -o /tmp/pipeline/merged.3mf
```
```
export-stl: 2873424 triangles   [scene export-stl] 1240.9ms
mesh info: 2873424 tris, vol=20517mm³
export-3mf: 2873424 triangles   [mesh export-3mf] 11666.7ms
```

## Step 13: Save final print file (Rust)

```bash
dragonfruit-cli print save /tmp/pipeline/print.nanodlp -o /tmp/pipeline/final.nanodlp
```
```
print save: print.nanodlp -> final.nanodlp   [print save] 0.3ms
```

## Output Artifacts

| File | Size | Description |
|------|------|-------------|
| `scene.voxl` | 2.2K | Scene state (models + supports + groups) |
| `print.nanodlp` | 98M | Sliced layer archive (1311 layers) |
| `final.nanodlp` | 98M | Final print file |
| `merged.stl` | 137M | Merged scene as binary STL |
| `merged.3mf` | 49M | Merged scene as 3MF |
| `layer300.png` | 85K | Layer 300 cross-section preview |
| `layer800.png` | 69K | Layer 800 cross-section preview |
| `islands/` | dir | Island scan results (642 islands) |

## Timing Summary

| Step | Tool | Command | Time |
|------|------|---------|------|
| Create scene | TS | `scene create` | 4ms |
| Add model | TS | `scene add-model` | 7ms |
| Rotate 15° | TS | `scene transform-model` | 5ms |
| Place on platform | TS | `scene place-on-platform` | 167ms |
| Duplicate ×2 | TS | `scene duplicate` | 5ms |
| Arrange (SAT) | TS | `scene arrange` | 635ms |
| Island scan | Rust | `island full` | 4,357ms |
| Add 9 supports | TS | `support add-*` ×7 | ~50ms |
| Update support | TS | `support update` | 7ms |
| Group models | TS | `scene group` | 8ms |
| Slice (merge+engine) | TS→Rust | `scene slice` | 23,398ms |
| Layer preview ×2 | Rust | `slice preview-layer` | 49ms |
| Export STL | TS→Rust | `scene export-stl` | 1,241ms |
| Export 3MF | Rust | `mesh export-3mf` | 11,667ms |
| Print save | Rust | `print save` | 0.3ms |
| **Total** | | | **~42s** |

## Interoperability

| Direction | Mechanism |
|-----------|-----------|
| TS → TS | `.voxl` file (VOXL V1 JSON, zlib compressed) |
| TS → Rust | `positions.bin` (flat f32 triangles) via temp file |
| Rust → TS | JSON stdout (`--json` flag) |
| Rust → Rust | `positions.bin` / `.nanodlp` archive / `.stl` / `.3mf` |
| GUI ↔ CLI | `.voxl` files (same format the GUI saves/loads) |
