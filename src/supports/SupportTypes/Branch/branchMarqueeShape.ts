import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { conePositions, jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Branch } from '../../types';

// A branch hangs from a parent knot, so its polyline starts there rather than at
// a root.
registerSupportMarqueeShape<Branch>('branch', (branch, ctx) => {
  ctx.chain(branch.id, branch.modelId, [
    ctx.state.knots[branch.parentKnotId]?.pos,
    ...jointPositions(branch.segments),
    ...(branch.contactCone ? conePositions(branch.contactCone) : []),
  ]);
});
