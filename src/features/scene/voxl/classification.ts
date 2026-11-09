import type { MeshHealthReport } from '@/utils/meshRepair';

/**
 * Whether a classification's model/support boundary addresses a soup of
 * `triangleCount` triangles.
 *
 * A classification is a triangle *index*, so it only means anything for the mesh the
 * classifying pass ended with — `post`, never `pre`. A classify-only run leaves
 * `pre == post`, so both agree; a repair changes the topology, and then only `post`
 * describes the triangles the caller holds, while `pre` is the mesh that was sent in.
 *
 * This is the one rule every writer and reader of the boundary shares; they all index
 * the same soup order (`docs/dev/voxl-format-spec.md`):
 *
 * - `ExportManager` stamps a classification only when this holds for the bytes it is
 *   about to store;
 * - `classificationForPayload` honours a stored one only when it holds for the payload
 *   just loaded, and otherwise drops it and re-runs the classifier;
 * - the CLI readers (`scripts/dragonfruit-ts-cli.ts`, `rust/dragonfruit-cli`) split at
 *   `model_triangle_count` only under the same condition.
 *
 * Getting it wrong is silent: a boundary one triangle out lands in the middle of
 * another triangle, and a dropped classification reorders the soup as the classifier
 * reports, which invalidates anything indexed by the old order.
 *
 * Kept in its own module with a type-only import so headless callers can use it
 * without loading the Tauri bridge that `@/utils/meshRepair` pulls in.
 */
export function reportAddressesTriangleSoup(
  report: MeshHealthReport,
  triangleCount: number,
): boolean {
  return report.post.triangle_count === triangleCount;
}
