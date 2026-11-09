/**
 * Display names for the mesh-repair stages.
 *
 * The engine passes each stage as a fixed code — `orient_holes_stitch`, `union_overlapping_parts` —
 * because the report keys on it and it has to stay language-neutral. Only the label in the progress
 * bar is translated, and only here. A stage the map does not know falls back to the raw code rather
 * than rendering blank, so a stage added to the engine shows up unnamed instead of missing.
 *
 * Module level on purpose: React Compiler renames locals inside components before the Lingui macro
 * derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

const STAGE_LABELS: Record<string, MessageDescriptor> = {
  // The two the automatic route reports: the local pipeline, and — when the local pipeline cannot
  // settle a mesh — the rebuild that resolves it into a solid.
  repair: msg`Repairing`,
  rebuild: msg`Rebuilding the surface into a solid`,
  orient_components: msg`Pointing faces the same way`,
  stitch: msg`Joining loose edges`,
  holes_trivial: msg`Closing small holes`,
  double_faces: msg`Removing doubled faces`,
  orient_holes_stitch: msg`Closing gaps`,
  orient_holes_all_stitch: msg`Closing the remaining gaps`,
  double_faces_after_split: msg`Removing doubled faces again`,
  split_self_intersections: msg`Separating surfaces that overlap`,
  split_non_manifold_edges: msg`Separating surfaces that share an edge`,
  union_overlapping_parts: msg`Merging overlapping parts`,
  filter_components: msg`Keeping the largest pieces`,
  remove_inner_faces: msg`Removing faces inside the model`,
  noise_shells: msg`Discarding scraps`,
  settle: msg`Tidying up`,
  prune_and_classify: msg`Separating model and supports`,
};

export function translateRepairStage(stage: string | undefined, translate: Translate): string {
  if (!stage) {
    return translate(
      msg({ message: 'Starting', comment: 'Mesh repair progress before the first stage reports in.' }),
    );
  }
  const descriptor = STAGE_LABELS[stage];
  return descriptor ? translate(descriptor) : stage;
}
