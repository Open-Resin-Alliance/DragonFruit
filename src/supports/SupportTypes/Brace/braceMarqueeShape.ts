import { registerSupportMarqueeShape } from '../../marqueeGeometry/seam';
import type { Brace } from '../../types';

// A brace spans two knots, so its polyline is the span between them.
registerSupportMarqueeShape<Brace>('brace', (brace, ctx) => {
  ctx.chain(brace.id, brace.modelId, [
    ctx.state.knots[brace.startKnotId]?.pos,
    ctx.state.knots[brace.endKnotId]?.pos,
  ]);
});
