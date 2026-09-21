import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Kickstand } from '../../types';

/**
 * A kickstand runs from its root up to the host knot it braces against.
 *
 * Its model id falls back to the ROOT's, because a kickstand may carry none of
 * its own; the marquee groups shapes by model, so a shape with no model is not
 * hit-testable at all.
 */
registerSupportMarqueeShape<Kickstand>('kickstand', (kickstand, ctx) => {
  const kickstandModelId = kickstand.modelId
    ?? ctx.state.roots[kickstand.rootId]?.modelId;
  ctx.chain(kickstand.id, kickstandModelId, [
    ctx.state.roots[kickstand.rootId]?.transform.pos,
    ...jointPositions(kickstand.segments),
    ctx.state.knots[kickstand.hostKnotId]?.pos
      ?? ctx.state.knots[kickstand.hostKnotId]?.pos,
  ]);
});
