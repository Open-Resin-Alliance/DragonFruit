import type { Roots, SupportState, Trunk } from '../../types';
import { registerHostPromotion, type HostPromotionRequest } from '../../supportTypeRegistry';
import { draftAddEntity, draftAddPrimitive } from '../../autoSupport/supportDraft';
import { planTrunkReplacement } from './TrunkReplacement/planTrunkReplacement';
import { applyTrunkReplacement } from './TrunkReplacement/applyTrunkReplacement';
import { getSnapshot, setSnapshot } from '../../state';

/**
 * A trunk yields its grid node to a candidate whose contact sits HIGHER.
 *
 * The candidate is promoted to a trunk and the trunk underneath it is removed,
 * with the removed one's own attachments rebuilt onto the promoted shaft. That
 * last part is why this is registered rather than inlined in the engine: the
 * rehosting rules belong to the trunk and nothing else can run them.
 */
export function promoteTrunkToHigherCandidate(request: HostPromotionRequest): SupportState | null {
    const { draft, placed, promotedMember, hostId, nodeKey, recordHistory } = request;

    // Read what this promotion needs off the generic payloads by the field names
    // the types' own `edges` declare -- the root the new trunk stands on, and
    // the member carrying the replaced host's contact. Nothing arrives as a
    // trunk-shaped or branch-shaped parameter.
    const rootToAdd = placed.supplied.rootId;
    const promoteKnot = promotedMember?.supplied.parentKnotId;
    if (!rootToAdd || !promotedMember || !promoteKnot) return null;

    // The promoted member has to be IN the draft before the planner runs: the
    // planner resolves it by id.
    let working = draftAddPrimitive(draft, 'knots', promoteKnot);
    working = draftAddEntity(working, promotedMember.typeId, promotedMember.entity);

    const planned = planTrunkReplacement({
        snapshot: working,
        trunkIdToRemove: hostId,
        mode: 'grid_promote_candidate_to_trunk',
        nodeKey,
        promoteBranchId: promotedMember.entity.id,
    });
    const plan = planned?.plan;
    if (!plan) return null;

    // Store-bound by necessity: the plan phase re-reads the live snapshot, so
    // the draft is committed, applied, and read back. `recordHistory` false lets
    // the auto run wrap the whole thing in its single undo entry.
    setSnapshot(working);
    const ok = applyTrunkReplacement(
        { ...plan, trunkToAdd: placed.entity as Trunk, rootToAdd: rootToAdd as Roots },
        undefined,
        { skipHistory: !recordHistory },
    );
    if (!ok) return null;

    return getSnapshot();
}

// Registered from the trunk's own folder, which is where this type may name
// itself: a host type's promotion replacement is that type's own business.
registerHostPromotion('trunk', promoteTrunkToHigherCandidate);
