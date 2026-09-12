"use client";

import React, { useMemo, useSyncExternalStore } from 'react';

import { subscribe, getSnapshot } from './state';
import { dumpSupportGroup, inspectSupport, ownerOfPickedId, type SupportInspection } from './supportInspector';
import { useResolvedSelectionState } from './interaction/shared/selection/resolvedSelectionStore';
import { getSupportsForModel, modelIdOfParentShaft } from './PlacementLogic/SupportModelLinker';
import {
    SUPPORT_PRIMITIVE_COLLECTIONS,
    SUPPORT_TYPES,
    type SupportCollectionKey,
} from './supportTypeRegistry';

/**
 * What is selected, what it is attached to, and what the active model holds.
 *
 * Reads the support store directly rather than through the page snapshot: that
 * one is deliberately empty while the app is in support mode, so counts taken
 * from it read zero exactly when this overlay is on screen.
 *
 * Every row is derived -- collections from the registry, links from each
 * type's declared edges, cascade size from the walk removal uses -- so no
 * support type is named here.
 */

interface SupportInspectorPanelProps {
    /** The model whose counts are shown. */
    activeModelId?: string | null;
    /** Hovered support id, when the pointer is over one. */
    hoveredSupportId?: string | null;
}

const short = (id: string) => `${id.slice(0, 8)}…`;

const MUTED = { color: 'var(--text-muted)' } as React.CSSProperties;
const WARN = { color: '#ffb060' } as React.CSSProperties;
const BAD = { color: '#ff8a8a' } as React.CSSProperties;

/** The declared edges out of a support, and whether each one resolves. */
function LinkRows({ inspection }: { inspection: SupportInspection }) {
    if (inspection.links.length === 0) {
        return (
            <>
                <div style={MUTED}>Attached to</div>
                <div>nothing (free-standing)</div>
            </>
        );
    }

    return (
        <>
            {inspection.links.map((link) => (
                <React.Fragment key={link.field}>
                    <div style={MUTED}>{link.ownership === 'owns' ? 'owns' : 'hangs off'}</div>
                    <div style={link.resolved ? undefined : BAD}>
                        {link.to} {short(link.id)}{link.resolved ? '' : ' — MISSING'}
                    </div>
                </React.Fragment>
            ))}
        </>
    );
}

/** One inspected support, as label/value rows. */
function InspectionRows({ inspection }: { inspection: SupportInspection }) {
    return (
        <>
            <div style={MUTED}>Type</div>
            <div style={{ color: '#ffb060' }}>{inspection.label}</div>

            <div style={MUTED}>Id</div>
            <div>{short(inspection.id)}</div>

            <div style={MUTED}>Model</div>
            <div style={inspection.modelId ? undefined : WARN}>
                {inspection.modelId ? short(inspection.modelId) : 'none (inherited)'}
            </div>

            {inspection.segmentCount > 0 && (
                <>
                    <div style={MUTED}>Segments</div>
                    <div>{inspection.segmentCount}</div>
                </>
            )}

            {inspection.contacts.map((contact) => (
                <React.Fragment key={contact.field}>
                    <div style={MUTED}>{contact.kind}</div>
                    <div style={contact.present ? undefined : WARN}>
                        {contact.field}{contact.present ? '' : ' — absent'}
                    </div>
                </React.Fragment>
            ))}

            <LinkRows inspection={inspection} />

            <div style={MUTED}>Hosts</div>
            <div>
                {inspection.dependents.length === 0
                    ? 'nothing'
                    : `${inspection.dependents.length} (${
                        [...new Set(inspection.dependents.map((d) => d.collection))].join(', ')
                    })`}
            </div>

            <div style={MUTED}>Delete takes</div>
            <div style={inspection.cascadeCount > 0 ? WARN : undefined}>
                {inspection.cascadeCount} other
            </div>

            {inspection.danglingLinks.length > 0 && (
                <>
                    <div style={MUTED}>Broken</div>
                    <div style={BAD}>{inspection.danglingLinks.map((l) => l.field).join(', ')}</div>
                </>
            )}
        </>
    );
}

export function SupportInspectorPanel({
    activeModelId,
    hoveredSupportId,
}: SupportInspectorPanelProps) {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const selection = useResolvedSelectionState();

    // A pick can land on a joint or a segment rather than the entity, so both
    // resolve to the support that owns them before anything is looked up.
    const picked = selection.selectedId ?? selection.selectedIds[0] ?? null;
    const primary = useMemo(
        () => (picked ? ownerOfPickedId(state, picked) : null),
        [state, picked],
    );
    const inspection = useMemo(
        () => (primary ? inspectSupport(state, primary.id) : null),
        [state, primary],
    );

    const hoveredOwner = useMemo(
        () => (hoveredSupportId ? ownerOfPickedId(state, hoveredSupportId) : null),
        [state, hoveredSupportId],
    );
    const hovered = useMemo(
        () => (hoveredOwner && hoveredOwner.id !== primary?.id
            ? inspectSupport(state, hoveredOwner.id)
            : null),
        [state, hoveredOwner, primary],
    );

    const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');

    // The label reverts on its own so the button does not stay stale after a
    // copy, and resets when the selection moves on.
    React.useEffect(() => {
        setCopyState('idle');
    }, [primary?.id]);

    React.useEffect(() => {
        if (copyState === 'idle') return;
        const timer = window.setTimeout(() => setCopyState('idle'), 2000);
        return () => window.clearTimeout(timer);
    }, [copyState]);

    const copyGroup = React.useCallback(() => {
        if (!primary) return;
        const dump = dumpSupportGroup(state, primary.id);
        if (!dump) {
            setCopyState('failed');
            return;
        }
        navigator.clipboard?.writeText(dump).then(
            () => setCopyState('copied'),
            () => setCopyState('failed'),
        );
    }, [state, primary]);

    /**
     * Scene-wide and active-model counts, per collection.
     *
     * A knot carries no `modelId`, so it resolves through the shaft segment it
     * sits on; everything else is read straight off its own field.
     */
    const counts = useMemo(() => {
        const byModel = activeModelId ? getSupportsForModel(state, activeModelId) : null;
        const rows: { key: SupportCollectionKey; label: string; all: number; active: number }[] = [];

        for (const descriptor of SUPPORT_TYPES) {
            const key = descriptor.location.key as SupportCollectionKey;
            rows.push({
                key,
                label: descriptor.label,
                all: Object.keys(state[key] ?? {}).length,
                active: byModel?.[key]?.length ?? 0,
            });
        }

        for (const primitive of SUPPORT_PRIMITIVE_COLLECTIONS) {
            const record = state[primitive.key] as unknown as
                Record<string, { modelId?: string; parentShaftId?: string }>;
            const entries = Object.values(record ?? {});
            rows.push({
                key: primitive.key,
                label: primitive.key,
                all: entries.length,
                active: !activeModelId ? 0 : entries.filter((entity) => (
                    entity.modelId
                        ? entity.modelId === activeModelId
                        : !!entity.parentShaftId
                            && modelIdOfParentShaft(state, entity.parentShaftId) === activeModelId
                )).length,
            });
        }

        return rows;
    }, [state, activeModelId]);

    return (
        <>
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={MUTED}>
                    Selected Support
                </div>
                {!inspection ? (
                    <div style={MUTED}>
                        {selection.selectedIds.length > 1
                            ? `${selection.selectedIds.length} supports selected`
                            : 'Nothing selected'}
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                            <InspectionRows inspection={inspection} />
                            {primary && primary.via !== 'entity' && (
                                <>
                                    <div style={MUTED}>Picked</div>
                                    <div>{primary.via} {short(picked!)}</div>
                                </>
                            )}
                        </div>
                        <button
                            type="button"
                            className="mt-1.5 w-full rounded border px-2 py-1 text-[10px]"
                            style={{
                                borderColor: 'var(--border-subtle)',
                                color: copyState === 'failed' ? '#ff8a8a' : 'var(--text-muted)',
                                pointerEvents: 'auto',
                            }}
                            onClick={copyGroup}
                        >
                            {copyState === 'copied'
                                ? `Copied ${inspection.cascadeCount + 1} entities`
                                : copyState === 'failed'
                                    ? 'Copy failed'
                                    : `Copy this + ${inspection.cascadeCount} connected`}
                        </button>
                    </>
                )}
            </div>

            {hovered && (
                <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={MUTED}>
                        Hovered Support
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <InspectionRows inspection={hovered} />
                        {hoveredOwner && hoveredOwner.via !== 'entity' && (
                            <>
                                <div style={MUTED}>Picked</div>
                                <div>{hoveredOwner.via} {short(hoveredSupportId!)}</div>
                            </>
                        )}
                    </div>
                </div>
            )}

            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={MUTED}>
                    Support Counts (all / active model)
                </div>
                {counts.map((row) => (
                    <div key={row.key}>
                        {row.label}: {row.all} / {row.active}
                    </div>
                ))}
            </div>
        </>
    );
}
