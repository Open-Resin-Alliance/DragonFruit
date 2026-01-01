import React, { useSyncExternalStore, useCallback, useMemo, useState, useRef } from 'react';
import * as THREE from 'three';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick, updateBrace, getTrunkById, getBranchById } from '../../state';
import { Trunk, Branch, Twig, Stick, Brace, Segment, BezierSegment, Joint } from '../../types';
import { BezierHandle } from './BezierHandle';
import { calculateControlPoint } from './utils';
import { useCurveInteractionState, curveInteractionStore } from '../../Curves/curveInteractionState';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';

interface HandleContext {
    id: string; // Unique ID for key
    trunk?: Trunk;
    branch?: Branch;
    twig?: Twig;
    stick?: Stick;
    brace?: Brace;
    joint: Joint;
    incomingSegment?: Segment; // Segment ending at this joint (from below)
    incomingIndex: number;
    outgoingSegment?: Segment; // Segment starting at this joint (going up)
    outgoingIndex: number;
    activeHandle: 'incoming' | 'outgoing'; // Which handle to show for this context
}

export function BezierGizmoManager() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    useCurveInteractionState();
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialBranchRef = useRef<Branch | null>(null);
    const initialTwigRef = useRef<Twig | null>(null);
    const initialStickRef = useRef<Stick | null>(null);
    const initialBraceRef = useRef<Brace | null>(null);

    // Helper to find all relevant handle contexts based on selection
    const findGizmoContexts = useCallback((): HandleContext[] => {
        const contexts: HandleContext[] = [];
        const trunks = Object.values(state.trunks);

        for (const trunk of trunks) {
            const segments = trunk.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                
                // Check Joint Selection
                // If Joint is selected, we show BOTH handles (incoming and outgoing) if applicable
                if (seg.topJoint?.id === selectedId) {
                    // Joint is "Top" of this segment (Incoming)
                    // It is also "Bottom" of next segment (Outgoing)
                    contexts.push({
                        id: `joint-${seg.topJoint.id}-incoming`,
                        trunk,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming'
                    });
                    contexts.push({
                        id: `joint-${seg.topJoint.id}-outgoing`,
                        trunk,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing'
                    });
                }
                
                // (No need to check bottomJoint explicitly for "Joint Selection" because 
                // every bottomJoint is someone else's topJoint, OR it's the first segment.
                // Wait, the first segment's bottomJoint connects to Root/Knot. It CAN be selected.)
                if (seg.bottomJoint?.id === selectedId && i === 0) {
                    // Only catch bottomJoint if it's the very first one (otherwise caught as topJoint of prev)
                    // But wait, segments store joints independently? No, joints are shared? 
                    // In my data model, they are distinct objects in the array, but might share ID?
                    // Usually joints are distinct entities.
                    
                    // If this is the bottom-most joint of the trunk:
                    contexts.push({
                        id: `joint-${seg.bottomJoint.id}-outgoing`,
                        trunk,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing'
                    });
                }

                // Check Segment Selection
                if (seg.id === selectedId && seg.type === 'bezier') {
                    // If this segment is selected, show handles at BOTH ends (its bottom and top)
                    
                    // 1. Handle at Bottom (Outgoing from bottom joint)
                    let bottomJoint = seg.bottomJoint;

                    // Fallback: Try to find the joint from the previous segment
                    if (!bottomJoint) {
                        if (i > 0) {
                            bottomJoint = segments[i - 1].topJoint;
                        } else {
                            // Use Root as Joint
                            const root = state.roots[trunk.rootId];
                            if (root) {
                                // Match offset from curveUtils.ts
                                const rPos = root.transform.pos;
                                const diskHeight = 0.5;
                                const coneHeight = root.height || 1.5;

                                bottomJoint = {
                                    id: root.id,
                                    pos: { 
                                        x: rPos.x, 
                                        y: rPos.y, 
                                        z: rPos.z + diskHeight + coneHeight 
                                    },
                                    diameter: root.diameter
                                };
                            }
                        }
                    }

                    if (bottomJoint) {
                         contexts.push({
                            id: `seg-${seg.id}-bottom`,
                            trunk,
                            joint: bottomJoint,
                            incomingSegment: segments[i - 1], // Might be undefined
                            incomingIndex: i - 1,
                            outgoingSegment: seg,
                            outgoingIndex: i,
                            activeHandle: 'outgoing'
                        });
                    }
                    
                    // 2. Handle at Top (Incoming to top joint)
                    if (seg.topJoint) {
                        contexts.push({
                            id: `seg-${seg.id}-top`,
                            trunk,
                            joint: seg.topJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: segments[i + 1], // Might be undefined
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    } else if (trunk.contactCone) {
                        // Handle Connection to Contact Cone
                        const socketPos = getFinalSocketPosition(trunk.contactCone);
                        const syntheticJoint: Joint = {
                            id: trunk.contactCone.socketJointId || 'cone-socket',
                            pos: { x: socketPos.x, y: socketPos.y, z: socketPos.z },
                            diameter: trunk.contactCone.profile?.bodyDiameterMm ?? seg.diameter
                        };

                        contexts.push({
                            id: `seg-${seg.id}-top-cone`,
                            trunk,
                            joint: syntheticJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: undefined,
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    }
                }
            }
        }

        // Also check branches (same logic as trunks)
        const branches = Object.values(state.branches);
        const knots = state.knots;

        for (const branch of branches) {
            const segments = branch.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                
                // Check Joint Selection
                if (seg.topJoint?.id === selectedId) {
                    contexts.push({
                        id: `branch-joint-${seg.topJoint.id}-incoming`,
                        branch,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming'
                    });
                    contexts.push({
                        id: `branch-joint-${seg.topJoint.id}-outgoing`,
                        branch,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing'
                    });
                }
                
                if (seg.bottomJoint?.id === selectedId && i === 0) {
                    contexts.push({
                        id: `branch-joint-${seg.bottomJoint.id}-outgoing`,
                        branch,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing'
                    });
                }

                // Check Segment Selection
                if (seg.id === selectedId && seg.type === 'bezier') {
                    let bottomJoint = seg.bottomJoint;

                    if (!bottomJoint) {
                        if (i > 0) {
                            bottomJoint = segments[i - 1].topJoint;
                        } else {
                            // Use Knot as Joint for branches
                            const parentKnot = knots[branch.parentKnotId];
                            if (parentKnot) {
                                bottomJoint = {
                                    id: parentKnot.id,
                                    pos: parentKnot.pos,
                                    diameter: 1.5 // Default
                                };
                            }
                        }
                    }

                    if (bottomJoint) {
                        contexts.push({
                            id: `branch-seg-${seg.id}-bottom`,
                            branch,
                            joint: bottomJoint,
                            incomingSegment: segments[i - 1],
                            incomingIndex: i - 1,
                            outgoingSegment: seg,
                            outgoingIndex: i,
                            activeHandle: 'outgoing'
                        });
                    }
                    
                    if (seg.topJoint) {
                        contexts.push({
                            id: `branch-seg-${seg.id}-top`,
                            branch,
                            joint: seg.topJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: segments[i + 1],
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    } else if (branch.contactCone) {
                        const socketPos = getFinalSocketPosition(branch.contactCone);
                        const syntheticJoint: Joint = {
                            id: branch.contactCone.socketJointId || 'cone-socket',
                            pos: { x: socketPos.x, y: socketPos.y, z: socketPos.z },
                            diameter: branch.contactCone.profile?.bodyDiameterMm ?? seg.diameter
                        };

                        contexts.push({
                            id: `branch-seg-${seg.id}-top-cone`,
                            branch,
                            joint: syntheticJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: undefined,
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    }
                }
            }
        }

        // Also check twigs.
        const twigs = Object.values(state.twigs);
        for (const twig of twigs) {
            const segments = twig.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id === selectedId) {
                    contexts.push({
                        id: `twig-joint-${seg.topJoint.id}-incoming`,
                        twig,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming'
                    });
                    contexts.push({
                        id: `twig-joint-${seg.topJoint.id}-outgoing`,
                        twig,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing'
                    });
                }

                if (seg.bottomJoint?.id === selectedId && i === 0) {
                    contexts.push({
                        id: `twig-joint-${seg.bottomJoint.id}-outgoing`,
                        twig,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing'
                    });
                }

                if (seg.id === selectedId && seg.type === 'bezier') {
                    if (seg.bottomJoint) {
                        contexts.push({
                            id: `twig-seg-${seg.id}-bottom`,
                            twig,
                            joint: seg.bottomJoint,
                            incomingSegment: segments[i - 1],
                            incomingIndex: i - 1,
                            outgoingSegment: seg,
                            outgoingIndex: i,
                            activeHandle: 'outgoing'
                        });
                    }
                    if (seg.topJoint) {
                        contexts.push({
                            id: `twig-seg-${seg.id}-top`,
                            twig,
                            joint: seg.topJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: segments[i + 1],
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    }
                }
            }
        }

        // Also check sticks.
        const sticks = Object.values(state.sticks);
        for (const stick of sticks) {
            const segments = stick.segments;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id === selectedId) {
                    contexts.push({
                        id: `stick-joint-${seg.topJoint.id}-incoming`,
                        stick,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming'
                    });
                    contexts.push({
                        id: `stick-joint-${seg.topJoint.id}-outgoing`,
                        stick,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'outgoing'
                    });
                }

                if (seg.bottomJoint?.id === selectedId && i === 0) {
                    contexts.push({
                        id: `stick-joint-${seg.bottomJoint.id}-outgoing`,
                        stick,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing'
                    });
                }

                if (seg.id === selectedId && seg.type === 'bezier') {
                    if (seg.bottomJoint) {
                        contexts.push({
                            id: `stick-seg-${seg.id}-bottom`,
                            stick,
                            joint: seg.bottomJoint,
                            incomingSegment: segments[i - 1],
                            incomingIndex: i - 1,
                            outgoingSegment: seg,
                            outgoingIndex: i,
                            activeHandle: 'outgoing'
                        });
                    }
                    if (seg.topJoint) {
                        contexts.push({
                            id: `stick-seg-${seg.id}-top`,
                            stick,
                            joint: seg.topJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: segments[i + 1],
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming'
                        });
                    }
                }
            }
        }

        // Also check braces.
        // Brace can be selected either by its support id (brace.id) or by its segment id (braceSegment:<braceId>).
        if (selectedId) {
            const braceId = selectedId.startsWith('braceSegment:')
                ? selectedId.slice('braceSegment:'.length)
                : selectedId;
            const brace = state.braces[braceId];

            if (brace?.curve?.type === 'bezier') {
                const startKnot = state.knots[brace.startKnotId];
                const endKnot = state.knots[brace.endKnotId];
                if (startKnot && endKnot) {
                    const startJoint: Joint = { id: startKnot.id, pos: startKnot.pos, diameter: startKnot.diameter ?? 1.5 };
                    const endJoint: Joint = { id: endKnot.id, pos: endKnot.pos, diameter: endKnot.diameter ?? 1.5 };

                    contexts.push({
                        id: `brace-${brace.id}-start-outgoing`,
                        brace,
                        joint: startJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: undefined,
                        outgoingIndex: 0,
                        activeHandle: 'outgoing',
                    });
                    contexts.push({
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
            }
        }

        return contexts;
    }, [selectedId, state.trunks, state.branches, state.twigs, state.sticks, state.braces, state.knots]);

    const contexts = findGizmoContexts();
    if (contexts.length === 0) return null;

    /**
     * Update Logic
     */
    const handleDragStart = (ctx: HandleContext) => {
        curveInteractionStore.setIsDraggingHandle(true);
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
        }
    };

    const handleDragEnd = (ctx: HandleContext) => {
        curveInteractionStore.setIsDraggingHandle(false);
        // Prevent canvas click (deselect)
        (window as any).__gizmoDragEndedThisFrame = true;

        // Push history for trunks
        if (initialTrunkRef.current && ctx.trunk) {
            const latestTrunk = getTrunkById(ctx.trunk.id);
            if (latestTrunk) {
                pushHistory({
                    type: SUPPORT_UPDATE_TRUNK,
                    payload: {
                        before: initialTrunkRef.current,
                        after: JSON.parse(JSON.stringify(latestTrunk)),
                    },
                });
            }
            initialTrunkRef.current = null;
        }
        // Note: Branch history not implemented yet
        initialBranchRef.current = null;
        initialTwigRef.current = null;
        initialStickRef.current = null;
        initialBraceRef.current = null;
    };

    const handleDrag = (ctx: HandleContext, newPos: THREE.Vector3) => {
        const { trunk, branch, twig, stick, brace, joint, incomingIndex, outgoingIndex, activeHandle } = ctx;
        const jointPos = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

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
        const parent = trunk || branch || twig || stick;
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
            updateTrunk(newParent as Trunk);
        } else if (branch) {
            updateBranch(newParent as Branch);
        } else if (twig) {
            updateTwig(newParent as Twig);
        } else if (stick) {
            updateStick(newParent as Stick);
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
