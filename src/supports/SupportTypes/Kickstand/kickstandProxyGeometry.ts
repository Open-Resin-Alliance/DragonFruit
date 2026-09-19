import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import type { Kickstand } from '../../types';

/**
 * A kickstand stands on its own root and braces up against a host knot, so it
 * needs both, and its last segment ends AT that knot rather than at a joint.
 *
 * Its host knot is deliberately not emitted: it is a selection-only interaction
 * affordance in SupportRenderer, and leaving it out keeps the proxy clean.
 */
registerSupportProxyGeometry<Kickstand>('kickstand', (kickstand, ctx) => {
  const root = ctx.state.roots[kickstand.rootId];
  const hostKnot = ctx.state.knots[kickstand.hostKnotId];
  if (!root || !hostKnot) return;

  ctx.pushRoot({
    id: root.id,
    supportId: kickstand.id,
    modelId: kickstand.modelId,
    basePos: root.transform.pos,
    bottomRadius: Math.max(0.001, root.diameter / 2),
    topRadius: Math.max(0.001, (kickstand.segments[0]?.diameter ?? root.diameter) / 2),
    effectiveDiskHeight: Math.max(0.001, root.diskHeight),
    coneHeight: Math.max(0, root.coneHeight),
  });

  let currentStart = {
    x: root.transform.pos.x,
    y: root.transform.pos.y,
    z: root.transform.pos.z + root.diskHeight + root.coneHeight,
  };

  for (const segment of kickstand.segments) {
    if (ctx.includeDetailedPrimitives && segment.bottomJoint) {
      ctx.pushJoint({
        id: segment.bottomJoint.id,
        pos: segment.bottomJoint.pos,
        diameter: segment.bottomJoint.diameter,
        supportId: kickstand.id,
        modelId: kickstand.modelId,
      });
    }

    const end = segment.topJoint?.pos ?? hostKnot.pos;
    ctx.pushSegmentShafts(segment, currentStart, end, kickstand.id, kickstand.modelId);

    if (ctx.includeDetailedPrimitives && segment.topJoint) {
      ctx.pushJoint({
        id: segment.topJoint.id,
        pos: segment.topJoint.pos,
        diameter: segment.topJoint.diameter,
        supportId: kickstand.id,
        modelId: kickstand.modelId,
      });
    }

    currentStart = end;
  }
});
