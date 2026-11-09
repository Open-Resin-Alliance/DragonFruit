import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import type { Leaf } from '../../types';

// A leaf is a contact cone on the model and a rod back to the knot it hangs
// from; without the rod it appears as a floating cone in proxy views.
registerSupportProxyGeometry<Leaf>('leaf', (leaf, ctx) => {
  const parentKnot = ctx.state.knots[leaf.parentKnotId];

  ctx.pushCone({
    ...leaf.contactCone,
    supportId: leaf.id,
    modelId: leaf.modelId,
  });

  if (parentKnot) {
    const tipSocket = getFinalSocketPosition(leaf.contactCone);
    const cone = leaf.contactCone;
    const rodDiameter = Math.max(0.001, cone.profile.bodyDiameterMm ?? 0.5);
    ctx.pushShaft({
      id: `leafRod:${leaf.id}`,
      supportId: leaf.id,
      modelId: leaf.modelId,
      start: tipSocket,
      end: parentKnot.pos,
      diameter: rodDiameter,
    });

    // The leaf's base knot sphere, which LeafRenderer draws always.
    ctx.pushJoint(
      {
        id: parentKnot.id,
        pos: parentKnot.pos,
        diameter: parentKnot.diameter ?? 1.2,
        supportId: leaf.id,
        modelId: leaf.modelId,
      },
      undefined,
      JOINT_DIAMETER_OFFSET_MM,
    );
  }
}, { detailedOnly: true });
