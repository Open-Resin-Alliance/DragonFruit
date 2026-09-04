# UAT scenarios

Manual verification scenarios in Given/When/Then form. There is no automated UAT
framework in this repo — these are scripts for a person to follow.

**Provenance and health warning.** These came from an external knowledge base
kept outside this repo, seeded by an agent harvest. They were written at
different times against different states of the code and **have not been
re-verified against current behaviour**. Treat a failing step as "check whether
the scenario is stale" before treating it as a bug.

Three further scenarios covering an on-demand rendering effort were discarded
rather than kept: the code they exercised is no longer in the tree
(`frameloop='demand'` survives only in `PrintingLayerGpuPreview.tsx`).
