import React, { useSyncExternalStore, useCallback, useMemo, useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick, updateBrace, getTrunkById, getBranchById } from '../../state';
import { Trunk, Branch, Twig, Stick, Brace, Segment, BezierSegment, Joint } from '../../types';
import { updateKickstand, useKickstandStoreState } from '../../SupportTypes/Kickstand/kickstandStore';
import type { Kickstand as KickstandEntity } from '../../SupportTypes/Kickstand/types';
import { BezierHandle } from './BezierHandle';
import { calculateControlPoint } from './utils';
import { useCurveInteractionState, curveInteractionStore } from '../../Curves/curveInteractionState';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { clearSupportDragPreview, emitSupportDragPreview } from '../../SupportPrimitives/Joint/jointDragRuntime';

interface HandleContext {
    id: string; // Unique ID for key
    trunk?: Trunk;
    branch?: Branch;
    twig?: Twig;
    stick?: Stick;
    brace?: Brace;
    kickstand?: KickstandEntity;
    joint: Joint;
    incomingSegment?: Segment; // Segment ending at this joint (from below)
    incomingIndex: number;
    outgoingSegment?: Segment; // Segment starting at this joint (going up)
    outgoingIndex: number;
    activeHandle: 'incoming' | 'outgoing'; // Which handle to show for this context
}

export function BezierGizmoManager() {
    const MIN_CONTROL_POINT_DELTA_SQ = 1e-10;
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const kickstandState = useKickstandStoreState();
    const selectedId = state.selectedId;
    const selectedCategory = state.selectedCategory;
    useCurveInteractionState();
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialBranchRef = useRef<Branch | null>(null);
    const initialTwigRef = useRef<Twig | null>(null);
    const initialStickRef = useRef<Stick | null>(null);
    const initialBraceRef = useRef<Brace | null>(null);
    const initialKickstandRef = useRef<KickstandEntity | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const liveTrunkPreviewRef = useRef<Trunk | null>(null);
    const liveBranchPreviewRef = useRef<Branch | null>(null);
    const liveTwigPreviewRef = useRef<Twig | null>(null);
    const liveStickPreviewRef = useRef<Stick | null>(null);
    const liveKickstandPreviewRef = useRef<KickstandEntity | null>(null);

    const setBezierGizmoInteractionFlags = useCallback((isDragging: boolean, postGuardMs = 180) => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        w.__bezierGizmoDragging = isDragging;
        w.__bezierGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

        window.dispatchEvent(new CustomEvent('bezier-gizmo-interaction-lock', {
            detail: {
                active: isDragging,
                guardUntil: w.__bezierGizmoGuardUntil,
            },
        }));
    }, []);

    const clearLiveSupportPreviews = useCallback(() => {
        if (liveTrunkPreviewRef.current) {
            clearSupportDragPreview('trunk', liveTrunkPreviewRef.current.id);
            liveTrunkPreviewRef.current = null;
        }
        if (liveBranchPreviewRef.current) {
            clearSupportDragPreview('branch', liveBranchPreviewRef.current.id);
            liveBranchPreviewRef.current = null;
        }
        if (liveTwigPreviewRef.current) {
            clearSupportDragPreview('twig', liveTwigPreviewRef.current.id);
            liveTwigPreviewRef.current = null;
        }
        if (liveStickPreviewRef.current) {
            clearSupportDragPreview('stick', liveStickPreviewRef.current.id);
            liveStickPreviewRef.current = null;
        }
        if (liveKickstandPreviewRef.current) {
            clearSupportDragPreview('kickstand', liveKickstandPreviewRef.current.id);
            liveKickstandPreviewRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => {
            clearLiveSupportPreviews();
            setBezierGizmoInteractionFlags(false, 0);
        };
    }, [setBezierGizmoInteractionFlags, clearLiveSupportPreviews]);

    const gizmoContextIndex = useMemo(() => {
        const jointContextsById = new Map<string, HandleContext[]>();
        const segmentContextsById = new Map<string, HandleContext[]>();
        const braceContextsById = new Map<string, HandleContext[]>();

        const pushContext = (map: Map<string, HandleContext[]>, key: string | null | undefined, context: HandleContext) => {
            if (!key) return;
            const existing = map.get(key);
            if (existing) {
                existing.push(context);
            } else {
                map.set(key, [context]);
            }
        };

        for (const trunk of Object.values(state.trunks)) {
            const segments = trunk.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `joint-${seg.topJoint.id}-incoming`,
                        trunk,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });

                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `joint-${seg.topJoint.id}-outgoing`,
                        trunk,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `joint-${seg.bottomJoint.id}-outgoing`,
                        trunk,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                let bottomJoint = seg.bottomJoint;
                if (!bottomJoint) {
                    if (i > 0) {
                        bottomJoint = segments[i - 1].topJoint;
                    } else {
                        const root = state.roots[trunk.rootId];
                        if (root) {
                            const rPos = root.transform.pos;
                            const diskHeight = 0.5;
                            const coneHeight = root.coneHeight || 1.5;
                            bottomJoint = {
                                id: root.id,
                                pos: {
                                    x: rPos.x,
                                    y: rPos.y,
                                    z: rPos.z + diskHeight + coneHeight,
                                },
                                diameter: root.diameter,
                            };
                        }
                    }
                }

                if (bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-bottom`,
                        trunk,
                        joint: bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-top`,
                        trunk,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                } else if (trunk.contactCone) {
                    const socketPos = getFinalSocketPosition(trunk.contactCone);
                    const syntheticJoint: Joint = {
                        id: trunk.contactCone.socketJointId || 'cone-socket',
                        pos: { x: socketPos.x, y: socketPos.y, z: socketPos.z },
                        diameter: trunk.contactCone.profile?.bodyDiameterMm ?? seg.diameter,
                    };

                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-top-cone`,
                        trunk,
                        joint: syntheticJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: undefined,
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                }
            }
        }

        for (const branch of Object.values(state.branches)) {
            const segments = branch.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `branch-joint-${seg.topJoint.id}-incoming`,
                        branch,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });

                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `branch-joint-${seg.topJoint.id}-outgoing`,
                        branch,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `branch-joint-${seg.bottomJoint.id}-outgoing`,
                        branch,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                let bottomJoint = seg.bottomJoint;
                if (!bottomJoint) {
                    if (i > 0) {
                        bottomJoint = segments[i - 1].topJoint;
                    } else {
                        const parentKnot = state.knots[branch.parentKnotId];
                        if (parentKnot) {
                            bottomJoint = {
                                id: parentKnot.id,
                                pos: parentKnot.pos,
                                diameter: 1.5,
                            };
                        }
                    }
                }

                if (bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `branch-seg-${seg.id}-bottom`,
                        branch,
                        joint: bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `branch-seg-${seg.id}-top`,
                        branch,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                } else if (branch.contactCone) {
                    const socketPos = getFinalSocketPosition(branch.contactCone);
                    const syntheticJoint: Joint = {
                        id: branch.contactCone.socketJointId || 'cone-socket',
                        pos: { x: socketPos.x, y: socketPos.y, z: socketPos.z },
                        diameter: branch.contactCone.profile?.bodyDiameterMm ?? seg.diameter,
                    };

                    pushContext(segmentContextsById, seg.id, {
                        id: `branch-seg-${seg.id}-top-cone`,
                        branch,
                        joint: syntheticJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: undefined,
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                }
            }
        }

        for (const twig of Object.values(state.twigs)) {
            const segments = twig.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `twig-joint-${seg.topJoint.id}-incoming`,
                        twig,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });

                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `twig-joint-${seg.topJoint.id}-outgoing`,
                        twig,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `twig-joint-${seg.bottomJoint.id}-outgoing`,
                        twig,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                if (seg.bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `twig-seg-${seg.id}-bottom`,
                        twig,
                        joint: seg.bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `twig-seg-${seg.id}-top`,
                        twig,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                }
            }
        }

        for (const stick of Object.values(state.sticks)) {
            const segments = stick.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `stick-joint-${seg.topJoint.id}-incoming`,
                        stick,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });

                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `stick-joint-${seg.topJoint.id}-outgoing`,
                        stick,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `stick-joint-${seg.bottomJoint.id}-outgoing`,
                        stick,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                if (seg.bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `stick-seg-${seg.id}-bottom`,
                        stick,
                        joint: seg.bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `stick-seg-${seg.id}-top`,
                        stick,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                }
            }
        }

        for (const brace of Object.values(state.braces)) {
            if (brace?.curve?.type !== 'bezier') continue;
            const startKnot = state.knots[brace.startKnotId];
            const endKnot = state.knots[brace.endKnotId];
            if (!startKnot || !endKnot) continue;

            const startJoint: Joint = { id: startKnot.id, pos: startKnot.pos, diameter: startKnot.diameter ?? 1.5 };
            const endJoint: Joint = { id: endKnot.id, pos: endKnot.pos, diameter: endKnot.diameter ?? 1.5 };

            pushContext(braceContextsById, brace.id, {
                id: `brace-${brace.id}-start-outgoing`,
                brace,
                joint: startJoint,
                incomingSegment: undefined,
                incomingIndex: -1,
                outgoingSegment: undefined,
                outgoingIndex: 0,
                activeHandle: 'outgoing',
            });

            pushContext(braceContextsById, brace.id, {
                id: `brace-${brace.id}-end-incoming`,
                brace,
                joint: endJoint,
                incomingSegment: undefined,
                incomingIndex: 0,
                outgoingSegment: undefined,
                outgoingIndex: 1,
                activeHandle: 'incoming',
            });
        }

        for (const kickstand of Object.values(kickstandState.kickstands)) {
            const segments = kickstand.segments;
            const hostKnot = kickstandState.knots[kickstand.hostKnotId];

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `kickstand-joint-${seg.topJoint.id}-incoming`,
                        kickstand,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });

                    pushContext(jointContextsById, seg.topJoint.id, {
                        id: `kickstand-joint-${seg.topJoint.id}-outgoing`,
                        kickstand,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `kickstand-joint-${seg.bottomJoint.id}-outgoing`,
                        kickstand,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                if (seg.bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `kickstand-seg-${seg.id}-bottom`,
                        kickstand,
                        joint: seg.bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `kickstand-seg-${seg.id}-top`,
                        kickstand,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                } else if (hostKnot) {
                    const syntheticJoint: Joint = {
                        id: hostKnot.id,
                        pos: hostKnot.pos,
                        diameter: hostKnot.diameter ?? seg.diameter,
                    };

                    pushContext(segmentContextsById, seg.id, {
                        id: `kickstand-seg-${seg.id}-top-host`,
                        kickstand,
                        joint: syntheticJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: undefined,
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                }
            }
        }

        return {
            jointContextsById,
            segmentContextsById,
            braceContextsById,
        };
    }, [
        state.trunks,
        state.roots,
        state.branches,
        state.twigs,
        state.sticks,
        state.braces,
        state.knots,
        kickstandState.kickstands,
        kickstandState.knots,
    ]);

    const contexts = useMemo(() => {
        if (!selectedId) return [] as HandleContext[];

        if (selectedCategory === 'joint') {
            return gizmoContextIndex.jointContextsById.get(selectedId) ?? [];
        }

        if (selectedCategory === 'segment') {
            if (selectedId.startsWith('braceSegment:')) {
                const braceId = selectedId.slice('braceSegment:'.length);
                return gizmoContextIndex.braceContextsById.get(braceId) ?? [];
            }
            return gizmoContextIndex.segmentContextsById.get(selectedId) ?? [];
        }

        if (selectedCategory === 'brace') {
            return gizmoContextIndex.braceContextsById.get(selectedId) ?? [];
        }

        // Defensive fallback when category has not yet synchronized.
        if (selectedId.startsWith('braceSegment:')) {
            const braceId = selectedId.slice('braceSegment:'.length);
            return gizmoContextIndex.braceContextsById.get(braceId) ?? [];
        }

        return [] as HandleContext[];
    }, [selectedId, selectedCategory, gizmoContextIndex]);
    if (contexts.length === 0) return null;

    /**
     * Update Logic
     */
    const handleDragStart = (ctx: HandleContext) => {
        clearLiveSupportPreviews();
        curveInteractionStore.setIsDraggingHandle(true);
        setBezierGizmoInteractionFlags(true);
        // Snapshot for history
        if (ctx.trunk) {
            initialTrunkRef.current = JSON.parse(JSON.stringify(ctx.trunk));
        } else if (ctx.branch) {
            initialBranchRef.current = JSON.parse(JSON.stringify(ctx.branch));
        } else if (ctx.twig) {
            initialTwigRef.current = JSON.parse(JSON.stringify(ctx.twig));
        } else if (ctx.stick) {
            initialStickRef.current = JSON.parse(JSON.stringify(ctx.stick));
        } else if (ctx.brace) {
            initialBraceRef.current = JSON.parse(JSON.stringify(ctx.brace));
        } else if (ctx.kickstand) {
            initialKickstandRef.current = JSON.parse(JSON.stringify(ctx.kickstand));
        }

        if (ctx.branch || ctx.twig || ctx.stick || ctx.brace || ctx.kickstand) {
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
        }
    };

    const handleDragEnd = (ctx: HandleContext) => {
        curveInteractionStore.setIsDraggingHandle(false);
        setBezierGizmoInteractionFlags(false);
        // Prevent canvas click (deselect)
        (window as any).__gizmoDragEndedThisFrame = true;

        // Push history for trunks
        if (initialTrunkRef.current && ctx.trunk) {
            const latestTrunk = liveTrunkPreviewRef.current ?? getTrunkById(ctx.trunk.id);
            if (latestTrunk) {
                // Final exact reconciliation after drag-time fast-path updates.
                updateTrunk(latestTrunk);
                pushHistory({
                    type: SUPPORT_UPDATE_TRUNK,
                    description: 'Edit trunk curve',
                    payload: {
                        before: initialTrunkRef.current,
                        after: JSON.parse(JSON.stringify(latestTrunk)),
                    },
                });
            }
            clearSupportDragPreview('trunk', ctx.trunk.id);
            liveTrunkPreviewRef.current = null;
            initialTrunkRef.current = null;
        }

        if (initialEditSnapshotRef.current) {
            if (ctx.branch) {
                const latestBranch = liveBranchPreviewRef.current ?? getBranchById(ctx.branch.id);
                if (latestBranch) {
                    // Final exact reconciliation after drag-time fast-path updates.
                    updateBranch(latestBranch);
                }
                clearSupportDragPreview('branch', ctx.branch.id);
                liveBranchPreviewRef.current = null;
                pushSupportEditHistory('Edit branch curve', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (ctx.twig) {
                if (liveTwigPreviewRef.current) {
                    updateTwig(liveTwigPreviewRef.current);
                }
                clearSupportDragPreview('twig', ctx.twig.id);
                liveTwigPreviewRef.current = null;
                pushSupportEditHistory('Edit twig curve', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (ctx.stick) {
                if (liveStickPreviewRef.current) {
                    updateStick(liveStickPreviewRef.current);
                }
                clearSupportDragPreview('stick', ctx.stick.id);
                liveStickPreviewRef.current = null;
                pushSupportEditHistory('Edit stick curve', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (ctx.brace) {
                pushSupportEditHistory('Edit brace curve', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (ctx.kickstand) {
                if (liveKickstandPreviewRef.current) {
                    updateKickstand(liveKickstandPreviewRef.current);
                }
                clearSupportDragPreview('kickstand', ctx.kickstand.id);
                liveKickstandPreviewRef.current = null;
                pushSupportEditHistory('Edit kickstand curve', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            }
            initialEditSnapshotRef.current = null;
        }

        initialBranchRef.current = null;
        initialTwigRef.current = null;
        initialStickRef.current = null;
        initialBraceRef.current = null;
        initialKickstandRef.current = null;
        clearLiveSupportPreviews();
    };

    const handleDrag = (ctx: HandleContext, newPos: THREE.Vector3) => {
        const { trunk, branch, twig, stick, brace, kickstand, joint, incomingIndex, outgoingIndex, activeHandle } = ctx;
        const jointPos = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

        const controlPointUnchanged = (
            cp: { x: number; y: number; z: number } | undefined,
            point: THREE.Vector3,
        ) => {
            if (!cp) return false;
            const dx = cp.x - point.x;
            const dy = cp.y - point.y;
            const dz = cp.z - point.z;
            return (dx * dx + dy * dy + dz * dz) <= MIN_CONTROL_POINT_DELTA_SQ;
        };

        if (brace) {
            if (!brace.curve || brace.curve.type !== 'bezier') return;
            const newBrace = JSON.parse(JSON.stringify(brace)) as Brace;

            const curve = newBrace.curve;
            if (!curve || curve.type !== 'bezier') return;

            // Calculate Vector from Joint -> New Handle Pos
            const handleVec = newPos.clone().sub(jointPos);
            const length = handleVec.length();
            if (length < 0.001) return;
            const direction = handleVec.clone().normalize();

            if (activeHandle === 'outgoing') {
                curve.startTangent = { x: direction.x, y: direction.y, z: direction.z };
                curve.controlPoint1 = { x: newPos.x, y: newPos.y, z: newPos.z };
            } else {
                const tangent = direction.clone().negate();
                curve.endTangent = { x: tangent.x, y: tangent.y, z: tangent.z };
                curve.controlPoint2 = { x: newPos.x, y: newPos.y, z: newPos.z };
            }

            updateBrace(newBrace);
            return;
        }

        // Get the parent (trunk/branch/twig/stick) and its segments
        const parent = trunk || branch || twig || stick || kickstand;
        if (!parent) return;

        // Clone to mutate
        const newParent = JSON.parse(JSON.stringify(parent));
        const newSegments = newParent.segments;

        // Calculate Vector from Joint -> New Handle Pos
        const handleVec = newPos.clone().sub(jointPos);
        const length = handleVec.length();
        if (length < 0.001) return;

        const direction = handleVec.clone().normalize();

        if (activeHandle === 'outgoing') {
             // Outgoing Segment (Above Joint) -> Controls startTangent
             const targetSeg = newSegments[outgoingIndex] as BezierSegment;
             if (!targetSeg || targetSeg.type !== 'bezier') return;

               if (controlPointUnchanged(targetSeg.controlPoint1, newPos)) return;

             targetSeg.startTangent = { x: direction.x, y: direction.y, z: direction.z };
             targetSeg.controlPoint1 = { x: newPos.x, y: newPos.y, z: newPos.z };

             // Seesaw Logic (Update Incoming)
             if (newSegments[incomingIndex]?.type === 'bezier') {
                 const otherSeg = newSegments[incomingIndex] as BezierSegment;
                 const otherDir = direction.clone().negate();
                 
                 otherSeg.endTangent = { x: otherDir.x, y: otherDir.y, z: otherDir.z };
                 if (otherSeg.controlPoint2) {
                     const otherCP = new THREE.Vector3(otherSeg.controlPoint2.x, otherSeg.controlPoint2.y, otherSeg.controlPoint2.z);
                     const otherLen = otherCP.distanceTo(jointPos);
                     const newOtherCP = jointPos.clone().add(otherDir.multiplyScalar(otherLen));
                     otherSeg.controlPoint2 = { x: newOtherCP.x, y: newOtherCP.y, z: newOtherCP.z };
                 }
             }

        } else {
             // Incoming Segment (Below Joint) -> Controls endTangent
             // Tangent = -HandleVector
             const targetSeg = newSegments[incomingIndex] as BezierSegment;
             if (!targetSeg || targetSeg.type !== 'bezier') return;

               if (controlPointUnchanged(targetSeg.controlPoint2, newPos)) return;
             
             const tangent = direction.clone().negate();
             targetSeg.endTangent = { x: tangent.x, y: tangent.y, z: tangent.z };
             targetSeg.controlPoint2 = { x: newPos.x, y: newPos.y, z: newPos.z };

             // Seesaw Logic (Update Outgoing)
             if (newSegments[outgoingIndex]?.type === 'bezier') {
                 const otherSeg = newSegments[outgoingIndex] as BezierSegment;
                 const otherDir = direction.clone().negate(); 
                 
                 otherSeg.startTangent = { x: otherDir.x, y: otherDir.y, z: otherDir.z };
                 if (otherSeg.controlPoint1) {
                     const otherCP = new THREE.Vector3(otherSeg.controlPoint1.x, otherSeg.controlPoint1.y, otherSeg.controlPoint1.z);
                     const otherLen = otherCP.distanceTo(jointPos);
                     const newOtherCP = jointPos.clone().add(otherDir.multiplyScalar(otherLen));
                     otherSeg.controlPoint1 = { x: newOtherCP.x, y: newOtherCP.y, z: newOtherCP.z };
                 }
             }
        }

        // Update the appropriate store
        if (trunk) {
            const previewTrunk = newParent as Trunk;
            liveTrunkPreviewRef.current = previewTrunk;
            emitSupportDragPreview('trunk', previewTrunk.id, previewTrunk);
        } else if (branch) {
            const previewBranch = newParent as Branch;
            liveBranchPreviewRef.current = previewBranch;
            emitSupportDragPreview('branch', previewBranch.id, previewBranch);
        } else if (twig) {
            const previewTwig = newParent as Twig;
            liveTwigPreviewRef.current = previewTwig;
            emitSupportDragPreview('twig', previewTwig.id, previewTwig);
        } else if (stick) {
            const previewStick = newParent as Stick;
            liveStickPreviewRef.current = previewStick;
            emitSupportDragPreview('stick', previewStick.id, previewStick);
        } else if (kickstand) {
            const previewKickstand = newParent as KickstandEntity;
            liveKickstandPreviewRef.current = previewKickstand;
            emitSupportDragPreview('kickstand', previewKickstand.id, previewKickstand);
        }
    };

    // Render each context handle
    return (
        <group>
            {contexts.map(ctx => {
                const jointPos = new THREE.Vector3(ctx.joint.pos.x, ctx.joint.pos.y, ctx.joint.pos.z);
                let cpPos: THREE.Vector3 | null = null;

                if (ctx.activeHandle === 'outgoing') {
                    if (ctx.brace?.curve?.type === 'bezier') {
                        cpPos = new THREE.Vector3(ctx.brace.curve.controlPoint1.x, ctx.brace.curve.controlPoint1.y, ctx.brace.curve.controlPoint1.z);
                    } else if (ctx.outgoingSegment?.type === 'bezier') {
                        const seg = ctx.outgoingSegment as BezierSegment;
                        if (seg.controlPoint1) {
                            cpPos = new THREE.Vector3(seg.controlPoint1.x, seg.controlPoint1.y, seg.controlPoint1.z);
                        } else {
                            const t = new THREE.Vector3(seg.startTangent.x, seg.startTangent.y, seg.startTangent.z);
                            cpPos = jointPos.clone().add(t.multiplyScalar(7));
                        }
                    }
                } else {
                    if (ctx.brace?.curve?.type === 'bezier') {
                        cpPos = new THREE.Vector3(ctx.brace.curve.controlPoint2.x, ctx.brace.curve.controlPoint2.y, ctx.brace.curve.controlPoint2.z);
                    } else if (ctx.incomingSegment?.type === 'bezier') {
                        const seg = ctx.incomingSegment as BezierSegment;
                        if (seg.controlPoint2) {
                            cpPos = new THREE.Vector3(seg.controlPoint2.x, seg.controlPoint2.y, seg.controlPoint2.z);
                        } else {
                            const t = new THREE.Vector3(seg.endTangent.x, seg.endTangent.y, seg.endTangent.z);
                            cpPos = jointPos.clone().sub(t.multiplyScalar(7));
                        }
                    }
                }

                if (!cpPos) return null;

                return (
                    <BezierHandle
                        key={ctx.id}
                        position={cpPos}
                        jointPosition={jointPos}
                        onDragStart={() => handleDragStart(ctx)}
                        onDrag={(newPos) => handleDrag(ctx, newPos)}
                        onDragEnd={() => handleDragEnd(ctx)}
                    />
                );
            })}
        </group>
    );
}
