import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { Stick } from '../../types';

/**
 * A stick works between two contact cones, so its shaft runs socket to socket.
 * The joints take the SEGMENT's diameter rather than the joint's.
 */
registerSupportProxyGeometry<Stick>('stick', (stick, ctx) => {
  if (ctx.includeDetailedPrimitives) {
    ctx.pushCone({
      ...stick.contactConeA,
      supportId: stick.id,
      modelId: stick.modelId,
    });
    ctx.pushCone({
      ...stick.contactConeB,
      supportId: stick.id,
      modelId: stick.modelId,
    });
  }

  for (const segment of stick.segments) {
    if (ctx.includeDetailedPrimitives && segment.bottomJoint) {
      ctx.pushJoint({
        id: segment.bottomJoint.id,
        pos: segment.bottomJoint.pos,
        diameter: segment.bottomJoint.diameter,
        supportId: stick.id,
        modelId: stick.modelId,
      });
    }

    const start = segment.bottomJoint?.pos ?? getFinalSocketPosition(stick.contactConeA);
    const end = segment.topJoint?.pos ?? getFinalSocketPosition(stick.contactConeB);

    ctx.pushSegmentShafts(segment, start, end, stick.id, stick.modelId);

    if (ctx.includeDetailedPrimitives && segment.topJoint) {
      ctx.pushJoint({
        id: segment.topJoint.id,
        pos: segment.topJoint.pos,
        diameter: segment.topJoint.diameter,
        supportId: stick.id,
        modelId: stick.modelId,
      });
    }
  }
});
