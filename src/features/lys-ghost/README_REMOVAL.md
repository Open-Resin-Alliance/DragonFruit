# REMOVAL INSTRUCTIONS - LYS GHOST VIEWER

This feature is a TEMPORARY DEBUGGING TOOL to visualize raw Lychee Slicer JSON coordinates.

## To Remove Completely:
1. Delete the folder `src/features/lys-ghost/`.
2. Open `src/features/islands/components/IslandScanCard.tsx`:
   - Remove the state `ghostData` and `showGhost`.
   - Remove the File Input handler `onLoadGhostJson`.
   - Revert the "Load Support Data (V2)" button to its original state (or delete it if unused).
3. Open `src/components/scene/SceneCanvas.tsx`:
   - Remove the `<GhostOverlay />` import and usage.
   - Remove the `ghostData` prop from the interface.
