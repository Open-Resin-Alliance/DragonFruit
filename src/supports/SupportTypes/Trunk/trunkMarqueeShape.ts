import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { conePositions, jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Trunk } from '../../types';

// A trunk runs from the top of the root it owns, down through its joints, to the
// contact at its tip. The root's own position is emitted by the root's recipe.
registerSupportMarqueeShape<Trunk>('trunk', (trunk, ctx) => {
  const root = ctx.state.roots[trunk.rootId];
  ctx.chain(trunk.id, trunk.modelId, [
    root?.transform.pos,
    ...jointPositions(trunk.segments),
    ...(trunk.contactCone ? conePositions(trunk.contactCone) : []),
  ]);
});
