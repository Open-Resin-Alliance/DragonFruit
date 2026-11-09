import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import type { Branch } from '../../types';

// A branch hangs from a parent knot, so it has no root of its own and its shaft
// starts at that knot. The knot is drawn as a sphere on the host shaft, which
// the proxy carries too.
registerSupportProxyGeometry<Branch>('branch', (branch, ctx) => {
  const parentKnot = ctx.state.knots[branch.parentKnotId];
  if (!parentKnot) return;

  if (ctx.includeDetailedPrimitives && branch.contactCone) {
    ctx.pushCone({
      ...branch.contactCone,
      supportId: branch.id,
      modelId: branch.modelId,
    });
  }

  let currentStart = parentKnot.pos;

  for (const segment of branch.segments) {
    if (ctx.includeDetailedPrimitives && segment.bottomJoint) {
      ctx.pushJoint({
        id: segment.bottomJoint.id,
        pos: segment.bottomJoint.pos,
        diameter: segment.bottomJoint.diameter,
        supportId: branch.id,
        modelId: branch.modelId,
      });
    }

    const end = segment.topJoint?.pos
      ?? (branch.contactCone ? getFinalSocketPosition(branch.contactCone) : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 5 });

    ctx.pushSegmentShafts(segment, currentStart, end, branch.id, branch.modelId);

    if (ctx.includeDetailedPrimitives && segment.topJoint) {
      ctx.pushJoint({
        id: segment.topJoint.id,
        pos: segment.topJoint.pos,
        diameter: segment.topJoint.diameter,
        supportId: branch.id,
        modelId: branch.modelId,
      });
    }

    currentStart = end;
  }

  // BranchRenderer draws the parent knot always, so the proxy must carry it too.
  if (ctx.includeDetailedPrimitives) {
    ctx.pushJoint(
      {
        id: parentKnot.id,
        pos: parentKnot.pos,
        diameter: parentKnot.diameter ?? 1.2,
        supportId: branch.id,
        modelId: branch.modelId,
      },
      undefined,
      // KnotRenderer blends the FULL joint offset; the segment joints use the
      // x0.75 proxy blend.
      JOINT_DIAMETER_OFFSET_MM,
    );
  }
});
