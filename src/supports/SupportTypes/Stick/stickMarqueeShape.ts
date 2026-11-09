import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { Stick } from '../../types';

// A stick ends at the SOCKET of each contact cone, not at the contact point the
// cone sits on, so both sockets are on the polyline as well as both contacts.
registerSupportMarqueeShape<Stick>('stick', (stick, ctx) => {
  ctx.chain(stick.id, stick.modelId, [
    stick.contactConeA.pos,
    getFinalSocketPosition(stick.contactConeA),
    ...jointPositions(stick.segments),
    getFinalSocketPosition(stick.contactConeB),
    stick.contactConeB.pos,
  ]);
});
