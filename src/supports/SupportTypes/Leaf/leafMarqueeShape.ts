import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { conePositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Leaf } from '../../types';

// A leaf is a parent knot and a contact cone, with no segments between them.
registerSupportMarqueeShape<Leaf>('leaf', (leaf, ctx) => {
  if (!leaf.contactCone) return;
  ctx.chain(leaf.id, leaf.modelId, [
    ctx.state.knots[leaf.parentKnotId]?.pos,
    ...conePositions(leaf.contactCone),
  ]);
});
