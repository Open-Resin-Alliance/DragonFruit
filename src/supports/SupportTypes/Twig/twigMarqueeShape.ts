import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import { jointPositions } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { Twig } from '../../types';

// A twig spans its two contact disks, with its joints between them.
registerSupportMarqueeShape<Twig>('twig', (twig, ctx) => {
  ctx.chain(twig.id, twig.modelId, [
    twig.contactDiskA.pos,
    ...jointPositions(twig.segments),
    twig.contactDiskB.pos,
  ]);
});
