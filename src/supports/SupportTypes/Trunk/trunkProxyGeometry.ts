import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { Trunk } from '../../types';

// A trunk owns the root it stands on, so its base comes from the store through
// `rootId`, and its shaft climbs from the top of that root's disk and cone.
registerSupportProxyGeometry<Trunk>('trunk', (trunk, ctx) => {
  const root = ctx.state.roots[trunk.rootId];
  if (!root) return;

  if (ctx.includeDetailedPrimitives && trunk.contactCone) {
    ctx.pushCone({
      ...trunk.contactCone,
      supportId: trunk.id,
      modelId: trunk.modelId,
    });
  }

  ctx.pushRoot({
    id: root.id,
    supportId: trunk.id,
    modelId: trunk.modelId,
    basePos: root.transform.pos,
    bottomRadius: Math.max(0.001, root.diameter / 2),
    topRadius: Math.max(0.001, (trunk.segments[0]?.diameter ?? root.diameter) / 2),
    effectiveDiskHeight: Math.max(0.001, root.diskHeight),
    coneHeight: Math.max(0, root.coneHeight),
  });

  let currentStart = {
    x: root.transform.pos.x,
    y: root.transform.pos.y,
    z: root.transform.pos.z + root.diskHeight + root.coneHeight,
  };

  for (const segment of trunk.segments) {
    if (ctx.includeDetailedPrimitives && segment.bottomJoint) {
      ctx.pushJoint({
        id: segment.bottomJoint.id,
        pos: segment.bottomJoint.pos,
        diameter: segment.bottomJoint.diameter,
        supportId: trunk.id,
        modelId: trunk.modelId,
      });
    }

    if (segment.bottomJoint) currentStart = segment.bottomJoint.pos;
    const end = segment.topJoint?.pos
      ?? (trunk.contactCone ? getFinalSocketPosition(trunk.contactCone) : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 5 });

    ctx.pushSegmentShafts(segment, currentStart, end, trunk.id, trunk.modelId);

    if (ctx.includeDetailedPrimitives && segment.topJoint) {
      ctx.pushJoint({
        id: segment.topJoint.id,
        pos: segment.topJoint.pos,
        diameter: segment.topJoint.diameter,
        supportId: trunk.id,
        modelId: trunk.modelId,
      });
    }

    currentStart = end;
  }
});
