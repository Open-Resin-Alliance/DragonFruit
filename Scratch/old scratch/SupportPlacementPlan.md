# Support Placement & Snapping - Development Plan

**Phase:** #3 of Support Development Roadmap  
**Date:** November 16, 2025  
**Prerequisites:** ✅ Data model foundation, ✅ Preset architecture

---

## 1. Overview

Enhance the support placement system with intelligent snapping, validation, and improved user feedback. Make it easier to place supports precisely where needed with visual guides and automatic alignment.

**Core Features:**
- Snapping to build plate
- Snapping to existing supports
- Placement validation (collision detection, minimum spacing)
- Visual feedback (valid/invalid placement indicators)
- Placement guides (grid, alignment helpers)

---

## 2. Goals

### Must Have (Phase 3A - Validation Only)
- ✅ Minimum tip spacing validation (prevent overlaps)
- ✅ Visual feedback for valid/invalid placement (green/red preview)
- ✅ Prevent placement if tips are too close
- ✅ Configurable minimum spacing distance

### Should Have (Phase 3B - Later)
- Snap to grid (requires design discussion)
- Snap to support tips (requires design discussion)
- Alignment guides (show when supports align)
- Placement angle constraints (prevent extreme angles)
- Support density warnings (too many/few in area)

### Could Have (Future)
- Auto-placement suggestions based on islands
- Batch placement mode (place multiple at once)
- Placement templates (patterns)
- Smart spacing based on support size
- Placement statistics (count, density, coverage)

---

## 3. Technical Design

### 3.1 Snapping System

**Snap Targets:**
1. **Build Plate** - Always snap base.z to 0
2. **Support Tips** - Snap tip to nearby support tips (within threshold)
3. **Grid** - Optional grid snapping for organized layouts
4. **Model Surface** - Already handled by raycast

**Snap Priority:**
```
1. Model surface (raycast hit) - highest priority
2. Support tips (if within snap distance)
3. Grid (if enabled)
4. Build plate (always for base)
```

**Snap Distance Thresholds:**
- Support tip snapping: 2mm default (configurable)
- Grid snapping: Based on grid size
- Minimum support spacing: 3mm default (configurable)

### 3.2 Validation System

**Validation Checks:**
1. **Collision Detection** - Check if support overlaps existing supports
2. **Minimum Spacing** - Ensure supports aren't too close
3. **Angle Validation** - Warn if support is too steep/shallow
4. **Base Placement** - Ensure base is on build plate
5. **Tip Placement** - Ensure tip is on model surface

**Validation States:**
- ✅ **Valid** - Green preview, can place
- ⚠️ **Warning** - Yellow preview, can place but not ideal
- ❌ **Invalid** - Red preview, cannot place

### 3.3 Visual Feedback

**Preview Colors:**
- **Green** - Valid placement
- **Yellow** - Warning (too close, steep angle, etc.)
- **Red** - Invalid (collision, off model, etc.)

**Visual Guides:**
- Snap indicators (small spheres at snap points)
- Alignment lines (when supports align)
- Spacing circles (show minimum spacing radius)
- Grid overlay (when grid snap enabled)

---

## 4. Implementation Tasks

### 4.1 Snapping Logic

**File:** `src/supports/snapping.ts` (new)

```typescript
export interface SnapResult {
  snapped: boolean;
  snapType: 'tip' | 'grid' | 'none';
  snapPoint?: { x: number; y: number; z: number };
  snapTargetId?: string; // Support ID if snapped to tip
}

export interface SnapConfig {
  enableTipSnap: boolean;
  enableGridSnap: boolean;
  tipSnapDistance: number;
  gridSize: number;
}

export function snapToSupportTips(
  point: { x: number; y: number; z: number },
  supports: SupportInstance[],
  config: SnapConfig
): SnapResult;

export function snapToGrid(
  point: { x: number; y: number; z: number },
  gridSize: number
): SnapResult;

export function findNearbySupports(
  point: { x: number; y: number; z: number },
  supports: SupportInstance[],
  radius: number
): SupportInstance[];
```

**Tasks:**
- [ ] Create snapping utility module
- [ ] Implement tip-to-tip snapping
- [ ] Implement grid snapping
- [ ] Add snap distance configuration
- [ ] Add snap visual indicators

---

### 4.2 Validation Logic

**File:** `src/supports/validation.ts` (new)

```typescript
export type ValidationLevel = 'valid' | 'warning' | 'invalid';

export interface ValidationResult {
  level: ValidationLevel;
  message: string;
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  type: 'collision' | 'spacing' | 'angle' | 'placement';
  severity: 'error' | 'warning';
  message: string;
  affectedSupportIds?: string[];
}

export interface ValidationConfig {
  minSpacingMm: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  checkCollisions: boolean;
}

export function validateSupportPlacement(
  tip: { x: number; y: number; z: number },
  base: { x: number; y: number; z: number },
  settings: SupportSettings,
  existingSupports: SupportInstance[],
  config: ValidationConfig
): ValidationResult;

export function checkSupportCollision(
  newSupport: { tip: Point; base: Point; settings: SupportSettings },
  existingSupports: SupportInstance[]
): boolean;

export function checkMinimumSpacing(
  point: { x: number; y: number; z: number },
  supports: SupportInstance[],
  minDistance: number
): { valid: boolean; nearestDistance: number; nearestId?: string };

export function validateSupportAngle(
  tip: { x: number; y: number; z: number },
  base: { x: number; y: number; z: number },
  minAngle: number,
  maxAngle: number
): { valid: boolean; angle: number };
```

**Tasks:**
- [ ] Create validation utility module
- [ ] Implement collision detection
- [ ] Implement spacing validation
- [ ] Implement angle validation
- [ ] Add validation configuration

---

### 4.3 Enhanced Preview

**Update:** `src/supports/SupportPreview.tsx`

Add validation-based coloring:
- Green material for valid placement
- Yellow material for warnings
- Red material for invalid placement

Add visual indicators:
- Snap point spheres
- Spacing radius circles
- Alignment guides

**Tasks:**
- [ ] Add validation color to preview
- [ ] Add snap point indicators
- [ ] Add spacing visualization
- [ ] Add alignment guides
- [ ] Improve preview performance

---

### 4.4 Placement Configuration UI

**File:** `src/supports/PlacementSettings.tsx` (new)

Add to SupportSidebar:
- Enable/disable snapping toggles
- Snap distance sliders
- Minimum spacing input
- Angle constraints inputs
- Grid size configuration

**Tasks:**
- [ ] Create PlacementSettings component
- [ ] Add snapping toggles
- [ ] Add spacing/distance inputs
- [ ] Add angle constraint inputs
- [ ] Integrate into SupportSidebar

---

### 4.5 Integration

**Update:** `src/supports/placement.ts`

Integrate snapping and validation:
```typescript
export function createSupportFromRaycast(
  hit: RaycastHit,
  settings: SupportSettings,
  existingSupports: SupportInstance[],
  snapConfig: SnapConfig,
  validationConfig: ValidationConfig
): { support: SupportInstance; validation: ValidationResult } | null;
```

**Update:** `src/app/page.tsx`

- Add snap/validation config state
- Pass config to placement function
- Show validation messages to user
- Prevent placement if invalid

**Tasks:**
- [ ] Update placement function with snapping
- [ ] Update placement function with validation
- [ ] Add config state to page.tsx
- [ ] Show validation feedback to user
- [ ] Prevent invalid placements

---

## 5. Execution Checklist (Phase 3A - Validation Only)

> Update as each item is completed

1. [x] Create validation utility module (`validation.ts`)
2. [x] Implement minimum tip spacing check (surface-to-surface)
3. [x] Implement fast nearest-neighbor search
4. [x] Update SupportPreview with validation colors (green/red)
5. [ ] Add spacing visualization (optional debug circles) - DEFERRED
6. [ ] Add minimum spacing config to SupportSidebar - DEFERRED
7. [x] Integrate validation into placement flow
8. [x] Prevent placement if validation fails
9. [x] Add user feedback for validation messages (toast notification)
10. [x] Test validation with various spacing values
11. [x] Document validation system (inline comments + plan)

**Deferred to Phase 3B (Snapping):**
- Create snapping utility module
- Implement tip-to-tip snapping
- Implement grid snapping
- Add snap point visual indicators
- Add alignment guides

---

## 6. Success Criteria

**Definition of Done:**
- ✅ Supports snap to nearby support tips automatically
- ✅ Visual feedback shows valid/warning/invalid states
- ✅ Cannot place supports that collide or are too close
- ✅ Preview changes color based on validation
- ✅ Snapping can be toggled on/off
- ✅ Minimum spacing is configurable
- ✅ All tests pass (manual validation)

**Performance Targets:**
- Validation runs < 10ms per placement
- No lag during preview movement
- Smooth snapping transitions

---

## 7. Future Enhancements

**After Phase #3 Complete:**
- Auto-placement based on island detection
- Batch placement mode
- Placement templates/patterns
- Smart density analysis
- Placement optimization suggestions
- Support strength analysis
- Resin cost estimation per support

---

## 8. Dependencies & Risks

**Dependencies:**
- ✅ Support store (Phase #1) - COMPLETE
- ✅ Preset system (Phase #2) - COMPLETE
- Existing raycast system
- Three.js raycasting

**Risks:**
- Performance with many supports (mitigated by spatial indexing)
- Complex collision detection (start simple, iterate)
- Too many validation warnings annoying users (make configurable)

**Mitigation:**
- Use spatial grid for fast nearest-neighbor queries
- Start with simple cylinder collision, add complexity later
- Make all validation toggleable
- Provide sensible defaults

---

## 9. Notes

- Keep validation fast - users need instant feedback
- Make snapping subtle but helpful
- Don't block users - warnings are better than errors
- Consider adding "placement mode" toggle (strict vs. permissive)
- Grid snapping should align with build plate dimensions
- Consider adding "auto-distribute" feature for even spacing
