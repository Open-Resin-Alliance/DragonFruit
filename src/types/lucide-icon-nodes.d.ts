/**
 * lucide-react's public API exposes icons as React components only; the raw
 * `IconNode` (path data) that each icon is built from lives in its ESM module
 * and is not re-exported with types. We read the node to rasterize a lucide
 * icon onto a canvas texture for the 3D viewcube, where DOM SVG cannot render.
 *
 * Example: `import { __iconNode } from 'lucide-react/dist/esm/icons/house';`
 */
declare module 'lucide-react/dist/esm/icons/*' {
  import type { IconNode } from 'lucide-react';

  export const __iconNode: IconNode;
}
