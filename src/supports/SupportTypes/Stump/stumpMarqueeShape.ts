import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { conePositions, jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Stump } from '../../types';

// A stump has no Roots entry, so its polyline starts at its OWN root position and
// runs through its own joint, then its segments, to the contact at its tip.
registerSupportMarqueeShape<Stump>('stump', (stump, ctx) => {
  ctx.chain(stump.id, stump.modelId, [
    stump.rootPos,
    stump.joint?.pos,
    ...jointPositions(stump.segments),
    ...(stump.contactCone ? conePositions(stump.contactCone) : []),
  ]);
});
