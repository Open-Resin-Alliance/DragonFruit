# Support Data Model & Persistence Plan

> Scope: detail the implementation tasks required to upgrade the support schema, storage, and serialization layer before we tackle joints/presets/UI work.

---

## 1. Goals

1. Represent Lychee-compatible support instances (including future joint metadata) without data loss.
2. Store supports in a normalized structure that survives reloads and is ready for undo/redo.
3. Keep the conversion codex accurate by documenting every new field and its mapping while ensuring our internal variable names stay unique (no 1:1 reuse of Lychee identifiers).
4. Follow project ideology: all support-related code must live in `stl-slicer/src/supports`, and features should be split into focused files/subdirectories (no monolithic modules).

---


## 2. Tasks & Details

### 2.1 Schema Extensions
- **SupportSettings** additions:
  - `tip`, `base`, `baseTip`, `mid`, `extra`, `adaptiveBase`, `isStraight`, joint parameter blocks.
  - Parameter types (numbers, enums) + validation helpers.
- **SupportInstance** additions:
  - Spatial fields: `tip`, `tipNormal`, `base`, `baseNormal`, `gridNodeIndex`.
  - Lifecycle flags: `isBaseTip`, `isInFill`, `isVisible`, `collisionIsAccepted`, `isCollidingWithObject`.
  - Hierarchy: `parentBaseId`, `parentTipId`, `parentId[]`, `group`, `tags`.
  - Versioning: `updatedAt`, `type`, future metadata.
- **Action Items:**
  1. Update TypeScript interfaces.
  2. Provide default factories (e.g., `createDefaultSupportSettings()`).
  3. Add zod/ts validation helpers for runtime checks.

### 2.2 Normalized State Store
- **Structure:**
  - `supports.byId: Record<string, SupportInstance>`
  - `supports.allIds: string[]`
  - Derived selectors for lists, filtered views, stats.
- **Implementation path:**
  1. Create a store module (e.g., Zustand or context hook) with add/remove/update actions.
  2. Replace ad-hoc arrays in `page.tsx` with selectors from the store.
  3. Ensure mutations are immutable and emit events for undo/redo.

### 2.3 Persistence & Serialization
- **Scene Save/Load:**
  - Extend scene JSON to include `supports` collection with byId/allIds.
  - On load, hydrate store and attach supports to objects (`supportsBase`).
  - On save, include new grid flags, presets references, etc.
- **Conversion Layer:**
  - Map every SupportInstance field to/from Lychee JSON (document in codex).
  - Handle missing fields gracefully (e.g., defaults when importing older files).

### 2.4 ID & Metadata Management
- **IDs:**
  - Decide on deterministic ID generation (e.g., `s${counter}` or UUID v4) and centralize it.
  - Store original Lychee IDs when importing for round-trip fidelity.
- **Metadata:**
  - Track `source` (manual vs imported) for debugging.
  - Reserve space for future per-support analytics (stability score cache, resin volume).

### 2.5 Testing & Verification
- Unit tests for:
  - Schema validation (creating/updating supports with new fields).
  - Store actions (add/update/remove, undo/redo integration points).
  - Serialization round-trip (export → import produces identical data).
- Integration/manual checklist:
  - Load legacy scenes (without supports) to ensure defaults behave.
  - Import Lychee scene snippet to confirm data parity.

---

## 3. Dependencies & Follow-ups
- **Needed before:** joint editing, preset UI, grid flags in UI.
- **Unlocks:**
  - Multi-joint placement (since schema already knows about joints).
  - Preset serialization (since settings are now complete).
  - Analytics caching (stability/resin) because data model has required fields.
- **Documentation:**
  - Update `SupportConversionCodex.md` with schema diagrams (reference only; the actual LYS conversion tool will be a separate project once support features are complete).
  - Add developer README section describing store usage and serialization expectations.

---

## 4. Execution Checklist

> Update this list as each item is completed. Use it as the authoritative record of progress for the data-model foundation.

1. [x] Extend `SupportSettings` interface + factories with full tip/base/baseTip/mid/extra/adaptiveBase/isStraight/joint fields.
2. [x] Extend `SupportInstance` interface + factories with spatial data, lifecycle flags, hierarchy refs, metadata, and defaults.
3. [x] Implement validation helpers (zod or equivalent) covering both settings and instance structures.
4. [x] Build normalized support store (byId/allIds) with add/update/remove/selectors.
5. [x] Replace `page.tsx` local arrays with selectors from the new store.
6. [x] Wire store into undo/redo hooks (emit change events / integrate with existing history system).
7. [x] Extend scene serialization (save/load) to persist the supports collection.
8. [x] Update conversion layer + codex with new field mappings and naming differences.
9. [x] Write unit tests for schema/store/serialization changes.
10. [x] Run manual save/load sanity checks with our own scenes (legacy scene vs new scene) and document outcomes. Lychee snippet testing will happen later when the separate converter exists.
