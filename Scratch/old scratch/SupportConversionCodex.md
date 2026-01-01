# Lychee ↔ AutoSupport Conversion Codex

> Living document that maps Lychee support structures to AutoSupport concepts for future import/export tooling.

---

## 1. Shared Fundamentals

| Concept | Lychee Representation | AutoSupport Representation | Notes |
| --- | --- | --- | --- |
| Units | Millimeters throughout (`settings.supports`, per-instance `tip/base`) | Millimeters (consistent with slicer) | Ensure no implicit unit conversion during import/export. |
| Scene Collections | `*.present.byId` + `*.present.allIds` | Same normalized pattern | Keep IDs stable for round-tripping. |
| Coordinate System | World positions in Lychee scene space (typically Z-up) | Z-up (matching our viewer) | Apply any scene transforms before writing. |

---

## 2. Geometry Presets (Support Styles)

Lychee block: `settings.supports.*` (`supportLight`, `supportMedium`, etc.) and `supportsPresets.presets.spX.settings`.

### Field Mapping Table

| AutoSupport Field | Lychee Field | Type | Notes |
| --- | --- | --- | --- |
| **Tip Profile** | | | |
| `tip.shape` | `tip.type` | `'cone' \| 'cylinder' \| 'cube'` | Internal uses `shape`, Lychee uses `type` |
| `tip.contactDiameterMm` | `tip.pointDiameter` | number | Small end touching model |
| `tip.bodyDiameterMm` | `tip.diameter` | number | Large end connecting to shaft |
| `tip.lengthMm` | `tip.length` | number | Tip section length |
| `tip.penetrationMm` | `tip.penetration` | number | How far tip embeds into model |
| `tip.coneAngleDeg` | `tip.angle` | number | Cone taper angle |
| `tip.breakpointMm` | `tip.breakPoint` | number | Transition point for complex tips |
| **Mid (Shaft) Profile** | | | |
| `mid.shape` | `mid.type` | `'cylinder' \| 'cube'` | Internal uses `shape`, Lychee uses `type` |
| `mid.diameterMm` | (inferred from tip/base) | number | Lychee doesn't store mid diameter explicitly |
| `mid.secondaryDiameterMm` | N/A | number | AutoSupport extension for tapered shafts |
| `mid.isStraight` | `isStraight` (global) | boolean | Whether shaft is straight or curved |
| **Base Profile** | | | |
| `base.shape` | `base.type` | `'cylinder' \| 'cube'` | Internal uses `shape`, Lychee uses `type` |
| `base.diameterMm` | `base.diameter` | number | Base platform diameter |
| `base.heightMm` | `base.length` | number | Base platform height |
| `base.sideAngleDeg` | `base.angle` | number | Base taper angle |
| `base.neckDiameterMm` | `base.joinDiameter` | number | Neck connecting base to shaft |
| `base.neckHeightMm` | `base.joinLength` | number | Neck height |
| `base.neckBlend` | `base.joinCone` | number | Blend factor (0-1) |
| **Base Joint Profile** | | | |
| `baseJoint.shape` | `baseTip.type` | `'cone' \| 'cube'` | For multi-segment supports |
| `baseJoint.contactDiameterMm` | `baseTip.pointDiameter` | number | Joint contact point |
| `baseJoint.bodyDiameterMm` | `baseTip.diameter` | number | Joint body diameter |
| `baseJoint.lengthMm` | `baseTip.length` | number | Joint section length |
| `baseJoint.penetrationMm` | `baseTip.penetration` | number | Joint penetration |
| `baseJoint.coneAngleDeg` | `baseTip.angle` | number | Joint taper angle |
| `baseJoint.allowRotation` | N/A | boolean | AutoSupport extension for joint articulation |
| **Extra Dimensions** | | | |
| `extra.tipContactDiameter2Mm` | `extra.tipDiameter2` | number | Secondary tip dimension |
| `extra.tipBodyDiameter2Mm` | `extra.tipBodyDiameter2` | number | Secondary tip body |
| `extra.baseDiameter2Mm` | `extra.baseDiameter2` | number | Secondary base dimension |
| `extra.baseJointBodyDiameter2Mm` | `extra.baseJointBodyDiameter2` | number | Secondary joint body |
| `extra.baseJointContactDiameter2Mm` | `extra.baseJointContactDiameter2` | number | Secondary joint contact |
| **Global Settings** | | | |
| `adaptiveBase` | `adaptiveBase` | boolean | Adaptive base sizing |
| `isTrunkStraight` | `isStraight` | boolean | Overall support straightness |
| **Joint Defaults** | | | |
| `jointDefaults.ballDiameterMm` | N/A | number | AutoSupport multi-joint extension |
| `jointDefaults.maxRotationDeg` | N/A | number | AutoSupport multi-joint extension |
| `jointDefaults.maxSlideMm` | N/A | number | AutoSupport multi-joint extension |

**Favorites and names:** `supportsPresets.favorites` ↔ AutoSupport preset bookmarks; `name` values become user-facing preset labels.

---

## 3. Bracing & Auto-Support Settings

| Lychee Field | AutoSupport Field | Notes |
| --- | --- | --- |
| `bracingPreset.settings.bpX` (pattern, gaps, heights) | `bracingProfiles[id]` | Preserve heights (`firstCathedralHeight`, `secondCathedralHeight`, `zStartPoint`), per-tier settings (`bottom/middle/top`). |
| `supportCreator` | `autoSupport.settings` | Includes `onlyIsland`, `autoBracing`, `interval`, `minBounds`, `autoParenting`, `maxMidLength`, `presetMinima`, `presetAutoSupportCustom.resolutionXY/Z`, `autoLift`. |
| `supportMode` / `supportModeFDM` | `autoSupport.mode` | Document which modes we support. |
| `islandsDetector` presets | `islandScanPresets` | Map `fast/normal/detailed` XY/Z resolutions. |

---

## 4. Support Instances (`supports.present.byId`)

Each Lychee support instance maps to an AutoSupport `SupportInstance`.

| Field | Lychee Key | AutoSupport Key | Notes |
| --- | --- | --- | --- |
| ID | `id` (`"s410"`) | `support.id` | Preserve string IDs or convert to UUID but keep original for export. |
| Tip attachment | `objectIdTip` | `support.objectIdTip` | References object mesh ID. |
| Tip position | `tip { x, y, z }` | `support.tip.position` | Float mm coordinates. |
| Tip normal | `tipNormal { x, y, z }` | `support.tip.normal` | Use normalized vector. `newTipNormal` optional override. |
| Base attachment | `objectIdBase` | `support.objectIdBase` | Plate or object. |
| Base position | `base { x, y, z }` | `support.base.position` | For plate attachments, z ~ 0. |
| Base normal | `baseNormal { x, y, z }` | `support.base.normal` | Often `{0,0,1}` for plate. |
| Geometry settings | `settings` block | `support.settings` | Copy entire structure (tip/base/baseTip/mid/extra/etc.). |
| Hierarchy | `parentBaseId`, `parentTipId`, `parentId[]` | `support.parents.base`, `support.parents.tip`, `support.parents.all` | Supports bracing/stacking. |
| Metadata | `isBaseTip`, `isInFill`, `gridNodeIndex`, `type`, `group`, `mini`, `vertical`, `straight`, `collisionIsAccepted`, `isCollidingWithObject`, `tags`, `updatedAt`, `isVisible` | Store in `support.meta` to keep parity. |

**Coordinate transforms:** when exporting, ensure AutoSupport support positions are transformed into Lychee’s scene coordinates (account for object transforms, plate offsets).

---

## 5. Objects, Plates, and Minima References

| Lychee Block | Purpose | Conversion Strategy |
| --- | --- | --- |
| `objects.present.byId` | Source meshes; includes `supportsBase` arrays referencing support IDs | On import, attach supports to matching objects. On export, fill `supportsBase`. |
| `plates.present.byId` | Build plate geometry & size | Map to AutoSupport plate definition; needed for base projection. |
| `minimas.present.byId` | Detected unsupported islands | Align with our island scan results; may enrich with additional analytics but keep `objectId`, `zPosition`, `area`, `angle`, `hasSupport`. |

---

## 6. Conversion Workflow Notes

1. **Import Lychee → AutoSupport**
   - Parse presets, bracing profiles, auto-support settings first.
   - Load objects/plates to build lookup tables.
   - Convert each support instance into `SupportInstance`, storing untouched geometry fields + metadata.
   - Optional: deduplicate settings to reference presets for UI convenience while retaining per-instance overrides.

2. **AutoSupport authoring → Lychee-compatible export**
   - Ensure every support has complete geometry fields (fill defaults where our UI omits values).
   - Serialize to `supports.present.byId`/`allIds`, referencing existing object IDs.
   - Rebuild `supportsPresets` if we expose custom styles (or embed per-instance settings only).
   - Output bracing + auto-support settings if needed; otherwise keep original values or mark as defaults.

3. **Extensibility**
   - Any AutoSupport-only enhancements (analytics, annotations, deformable bases) should live in separate namespaces so exports remain clean.
   - Version the codex and conversion tooling so future schema changes (e.g., Lychee updates) can be tracked.

---

## 7. Open Questions / TODOs

1. Confirm Lychee’s `type` field semantics (observed `1` = standard resin support). Need mapping list for other types.
2. Determine how Lychee stores bracing instances (if separate from supports) for full round-trip.
3. Validate coordinate transform order when objects are rotated/scaled prior to support placement.
4. Decide whether to infer presets from per-instance settings or always store a local copy.
5. Investigate `gridNodeIndex` usage—whether required for export or optional.

(Keep updating this codex as we uncover more fields or finalize our internal schemas.)
