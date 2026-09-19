import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import type { Stump } from '../../types';

/**
 * A stump is a frustum root under a contact cone, with no shafts at all and no
 * Roots entry: the frustum IS its root, so its base dimensions come off the
 * entity's own fields rather than from the store.
 */
registerSupportProxyGeometry<Stump>('stump', (stump, ctx) => {
  ctx.pushRoot({
    id: `${stump.id}:root`,
    supportId: stump.id,
    modelId: stump.modelId,
    basePos: stump.rootPos,
    bottomRadius: Math.max(0.001, stump.rootBaseDiameter / 2),
    topRadius: Math.max(0.001, stump.rootTopDiameter / 2),
    effectiveDiskHeight: 0.1,
    coneHeight: Math.max(0, stump.rootHeight),
  });

  if (ctx.includeDetailedPrimitives && stump.contactCone) {
    ctx.pushCone({
      ...stump.contactCone,
      supportId: stump.id,
      modelId: stump.modelId,
    });
  }
});
