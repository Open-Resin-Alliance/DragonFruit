# LYS Hollowing Format Notes

Notes on how the LYS scene JSON represents hollowing, based on two exported scenes of the same model (`D_Burst_Cannon_Complete`). The importer does not currently read any hollowing data; this is a reference for if and when we map it.

Source files inspected:
- `D_Burst_Cannon_Complete-Single_Scene.json` (surface-offset form, object `o11`)
- `D_Burst_Cannon_Complete-Single_Scene.json` (later re-export, voxel form, object `o13`)

## Where hollowing lives in the JSON

Hollowing is not one block. It is spread across the object and a few top-level containers, all keyed to the object id.

| Location | Holds |
| --- | --- |
| `objects.present.byId.<objId>.hollowing` | the main hollowing settings block |
| `objects.present.byId.<objId>.autoHoles` | automatic drain-hole generation settings |
| `objects.present.byId.<objId>.holes` | list of drain-hole ids belonging to this object |
| `objects.present.byId.<objId>.hollowBlockers` | list of blocker ids on this object |
| `objects.present.byId.<objId>.hasHollowing2D` | flag, true when hollowing is applied |
| `objects.present.byId.<objId>.updatedHollowVoxelsAt` | timestamp, non-zero once the voxel pass has run |
| `objects.present.byId.<objId>.updatedHollowBlockersAt` | timestamp for blockers |
| `holes.present.byId` (top level) | full drain-hole definitions |
| `hollowBlockers.present.byId` (top level) | full blocker definitions (empty in both scenes) |
| `minimas.present.byId` (top level) | local-minima points, populated alongside the voxel/pocket workflow |

There are also two `hollowing` blocks inside the top-level `settings` section that use an older, leaner schema (`enabled`, `quality`, `thickness`). These appear to be defaults or presets, not the live per-object config. They are noted at the end.

## Coordinate space caveat

Drain-hole `tip` and `tipNormal` are in object-local space, the same as support `base`/`tip`. They must be run through the object transform (rotation plus position) before they land in world space, exactly like the importer already does for support contacts via `transformObjectPoint`. Do not treat the raw values as world coordinates.

---

## The two hollowing forms observed

Both scenes are the same model with hollowing enabled. The difference is the method and a few values. The schema shape is identical between them; only flag values and the `autoHoles` block differ.

### Side-by-side

| Field | Form A (surface-offset, `o11`) | Form B (voxel, `o13`) | Meaning |
| --- | --- | --- | --- |
| `enabled` | true | true | hollowing is on |
| `useVoxels` | false | true | the distinguishing flag: surface-offset vs voxel method |
| `pocketDetection` | false | true | detect enclosed pockets that cannot drain |
| `outer` | 2 | 1.6 | wall thickness in mm |
| `wallPrecision` | 4 | 4 | inner-wall mesh resolution / quality |
| `wallSmooth` | 0.1 | 0.1 | smoothing applied to the inner wall |
| `infillEnabled` | false | false | internal lattice / infill off |
| `infillInterval` | 5 | 5 | infill spacing, used only when infill is enabled |
| `pocketDetectionMinPocketVoxels` | 0.01 | 0.01 | min pocket size in voxels to count |
| `pocketDetectionMinPocketSide` | 0.01 | 0.01 | min pocket side to count |
| `pocketDetectionRemoveBelowHoles` | true | true | ignore pockets that sit below existing holes |
| `pocketDetectionWithoutHoles` | false | false | detect pockets even where no holes exist |
| `updatedHollowVoxelsAt` | 0 | non-zero timestamp | non-zero means the voxel pass actually ran |
| `autoHoles` | not meaningfully present | `{ numberOfHolesByPockets: 3, holesDiameter: 2, holesSpacing: 5 }` | auto drain-hole generation tied to pocket detection |
| `minimas` (top level) | empty | 109 entries | local-minima points, populated with the voxel/pocket pass |

### Form A: surface-offset hollowing

The headline intent: enabled, 2mm walls, no infill, surface-offset method, no pocket detection.

```json
"hollowing": {
  "enabled": true,
  "useVoxels": false,
  "pocketDetection": false,
  "outer": 2,
  "wallPrecision": 4,
  "wallSmooth": 0.1,
  "infillEnabled": false,
  "infillInterval": 5,
  "pocketDetectionMinPocketVoxels": 0.01,
  "pocketDetectionMinPocketSide": 0.01,
  "pocketDetectionRemoveBelowHoles": true,
  "pocketDetectionWithoutHoles": false,
  "showNotification": null,
  "updatedAt": 1780962057571
}
```

- `updatedHollowVoxelsAt` was `0`, meaning the voxel pass never ran (consistent with `useVoxels: false`).
- `minimas` was empty.

### Form B: voxel hollowing with pocket detection

The headline intent: enabled, thinner 1.6mm walls, voxel method, pocket detection on, auto drain holes configured, voxel pass actually executed.

```json
"hollowing": {
  "enabled": true,
  "useVoxels": true,
  "pocketDetection": true,
  "outer": 1.6,
  "wallPrecision": 4,
  "wallSmooth": 0.1,
  "infillEnabled": false,
  "infillInterval": 5,
  "pocketDetectionMinPocketVoxels": 0.01,
  "pocketDetectionMinPocketSide": 0.01,
  "pocketDetectionRemoveBelowHoles": true,
  "pocketDetectionWithoutHoles": false,
  "showNotification": null,
  "updatedAt": 1780964609201
}
```

- `updatedHollowVoxelsAt` was a real timestamp, meaning the voxel computation ran.
- `autoHoles` was populated: 3 holes per pocket, 2mm diameter, 5mm spacing.
- `minimas` had 109 entries.

---

## Drain holes

Drain holes are stored in the top-level `holes.present.byId` and referenced from the object via `object.holes` (a list of ids). Both scenes had 3 holes with identical settings, just renumbered between exports (`h7/h8/h9` then `h13/h14/h15`).

Each hole:

```json
{
  "id": "h13",
  "objectId": "o13",
  "isExportable": true,
  "tip": { "x": 0.475, "y": -18.076, "z": -27.536 },
  "tipNormal": { "x": ~0, "y": -1, "z": ~0 },
  "tipRotation": null,
  "settings": {
    "type": "cylinder",
    "diameter": 5,
    "depth": 3.5,
    "hole": { "type": "cylinder" }
  }
}
```

- `objectId` ties the hole to its object.
- `tip` and `tipNormal` are object-local (see the coordinate caveat).
- `settings` describes the geometry: a 5mm diameter, 3.5mm deep cylinder here.
- `isExportable` marks whether it is included on export.

## Hollow blockers

`hollowBlockers` exists at both the top level and on the object, but is empty in both scenes. When present, these are regions that prevent hollowing in a specific area. No examples captured yet.

## Minimas

`minimas.present.byId` is empty in Form A and has 109 entries in Form B. These are local-minima points, which line up with the voxel and pocket-detection workflow (places resin can get trapped). Worth a closer look if hollowing and draining become a target, but not strictly part of the hollowing settings block.

---

## Older settings-level schema (presets/defaults)

Inside the top-level `settings` section there are `hollowing` blocks using a different, leaner shape:

```json
"hollowing": { "enabled": false, "quality": 4, "thickness": 1.5 }
"hollowing": { "enabled": false, "quality": 1, "thickness": 2 }
```

These use `thickness` for wall thickness and `quality` for precision, whereas the per-object block uses `outer` and `wallPrecision`. If hollowing is ever mapped, this naming difference (`thickness` vs `outer`, `quality` vs `wallPrecision`) needs reconciling. These blocks appear to be defaults or presets rather than the applied per-object config.

---

## Field glossary (per-object hollowing block)

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | bool | hollowing applied to this object |
| `outer` | number (mm) | wall thickness |
| `useVoxels` | bool | voxel method when true, surface-offset when false |
| `wallPrecision` | number | inner-wall mesh resolution / quality |
| `wallSmooth` | number | smoothing applied to the inner wall |
| `infillEnabled` | bool | internal lattice / infill on |
| `infillInterval` | number | infill spacing |
| `pocketDetection` | bool | detect enclosed pockets that cannot drain |
| `pocketDetectionMinPocketVoxels` | number | min pocket size in voxels to count |
| `pocketDetectionMinPocketSide` | number | min pocket side to count |
| `pocketDetectionRemoveBelowHoles` | bool | ignore pockets below existing holes |
| `pocketDetectionWithoutHoles` | bool | detect pockets even with no holes |
| `showNotification` | nullable | UI notification state, not geometry |
| `updatedAt` | timestamp | last settings change |

| Object field outside the block | Meaning |
| --- | --- |
| `autoHoles.numberOfHolesByPockets` | auto drain holes generated per detected pocket |
| `autoHoles.holesDiameter` | diameter of auto-generated drain holes (mm) |
| `autoHoles.holesSpacing` | spacing between auto-generated drain holes (mm) |
| `holes` | list of drain-hole ids on this object |
| `hollowBlockers` | list of blocker ids on this object |
| `hasHollowing2D` | flag, true when hollowing is applied |
| `updatedHollowVoxelsAt` | non-zero once the voxel pass has run |
| `updatedHollowBlockersAt` | timestamp for blockers |
