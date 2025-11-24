# Leaf Support System

Minimal contact-cone-only supports that connect parent supports to the model.

## Overview

Leaves are ultra-light supports made entirely of contact cones that connect a branch or trunk directly to the model. They have:
- **Contact face** (small end): touches the model
- **Socket face** (large end): snaps to parent support shaft
- **NO shaft, NO joints, NO base** - just the contact cone

## Usage

### Activation
- Press and hold **Ctrl+Alt** to enter leaf placement mode
- Cursor changes to indicate leaf mode is active

### Placement Workflow
1. **First click**: Place contact face on the model surface
   - Click on the model where you want the leaf to touch
   - Contact face (small end) will be positioned at this point
   - Preview cone appears

2. **Second click**: Place socket face on parent support
   - Move mouse near any support shaft (trunk or branch)
   - Socket will snap to the nearest support within 2mm
   - Preview changes color when snapped (green-cyan → bright cyan)
   - Click to finalize the leaf

3. **Cancel**: Release Ctrl+Alt to cancel placement

## Technical Details

### Structure
- Uses `SupportTipProfile` for cone geometry
- `type: 2` identifies leaf supports (vs type 1 for branches)
- `tags: ['leaf']` for filtering
- `parentBaseId` references the parent support
- `joints: []` - empty array (no joints)

### Snapping
- Snaps to any support shaft (trunk or branch)
- Snap distance: 2.0mm (configurable via `LEAF_SNAP_DISTANCE`)
- Uses camera-aware depth prioritization
- Calculates normal perpendicular to shaft

### Rendering
- Preview shows contact cone with socket marker
- Color: `#00ff88` (green-cyan) when not snapped
- Color: `#00ffcc` (bright cyan) when snapped
- Opacity: 0.6 for cone, 0.95 for socket marker

## Files

- `types.ts` - Type definitions for leaf placement state
- `constants.ts` - Configuration constants (hotkey, colors, snap distance)
- `featureFlag.ts` - Feature toggle
- `createLeaf.ts` - Factory function for creating leaf instances
- `placement/useLeafPlacement.ts` - React hook for placement logic
- `snapping/snapToSupport.ts` - Snapping algorithm for any support
- `rendering/LeafPreview.tsx` - Preview visualization component
- `index.ts` - Public API exports

## Integration

Leaf supports integrate with the existing support system:
- Inherit settings from active preset
- Participate in parent-child relationships
- Can be selected, deleted, and managed like other supports
- Respect collision detection and validation rules
