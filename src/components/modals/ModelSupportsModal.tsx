'use client';

import React from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { getSnapshot as getSupportSnapshot, subscribe as subscribeSupportState } from '@/supports/state';
import { getSupportBraceSnapshot, subscribeToSupportBraceStore } from '@/supports/SupportTypes/SupportBrace/supportBraceStore';

type ModelSupportsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  model: LoadedModel | null;
};

type ModelSupportGroups = {
  roots: string[];
  trunks: string[];
  branches: string[];
  leaves: string[];
  twigs: string[];
  sticks: string[];
  braces: string[];
  knots: string[];
  supportBraces: string[];
};

const EMPTY_GROUPS: ModelSupportGroups = {
  roots: [],
  trunks: [],
  branches: [],
  leaves: [],
  twigs: [],
  sticks: [],
  braces: [],
  knots: [],
  supportBraces: [],
};

function pluralize(label: string, count: number) {
  return `${count.toLocaleString()} ${label}${count === 1 ? '' : 's'}`;
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function ModelSupportsModal({ isOpen, onClose, model }: ModelSupportsModalProps) {
  const supportSnapshot = React.useSyncExternalStore(subscribeSupportState, getSupportSnapshot, getSupportSnapshot);
  const supportBraceSnapshot = React.useSyncExternalStore(subscribeToSupportBraceStore, getSupportBraceSnapshot, getSupportBraceSnapshot);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const groups = React.useMemo<ModelSupportGroups>(() => {
    const modelId = model?.id;
    if (!modelId) return EMPTY_GROUPS;

    const roots = sortIds(Object.values(supportSnapshot.roots).filter((item) => item.modelId === modelId).map((item) => item.id));
    const trunks = sortIds(Object.values(supportSnapshot.trunks).filter((item) => item.modelId === modelId).map((item) => item.id));
    const branches = sortIds(Object.values(supportSnapshot.branches).filter((item) => item.modelId === modelId).map((item) => item.id));
    const leaves = sortIds(Object.values(supportSnapshot.leaves).filter((item) => item.modelId === modelId).map((item) => item.id));
    const twigs = sortIds(Object.values(supportSnapshot.twigs).filter((item) => item.modelId === modelId).map((item) => item.id));
    const sticks = sortIds(Object.values(supportSnapshot.sticks).filter((item) => item.modelId === modelId).map((item) => item.id));
    const braces = sortIds(Object.values(supportSnapshot.braces).filter((item) => item.modelId === modelId).map((item) => item.id));
    const supportBraces = sortIds(Object.values(supportBraceSnapshot.supportBraces).filter((item) => item.modelId === modelId).map((item) => item.id));

    const knots = sortIds(Object.values(supportSnapshot.knots).filter((item) => {
      const parent = item.parentShaftId;
      const trunk = supportSnapshot.trunks[parent];
      if (trunk) return trunk.modelId === modelId;
      const branch = supportSnapshot.branches[parent];
      if (branch) return branch.modelId === modelId;
      const twig = supportSnapshot.twigs[parent];
      if (twig) return twig.modelId === modelId;
      const stick = supportSnapshot.sticks[parent];
      if (stick) return stick.modelId === modelId;
      if (parent.startsWith('braceSegment:')) {
        const braceId = parent.slice('braceSegment:'.length);
        return supportSnapshot.braces[braceId]?.modelId === modelId;
      }
      return false;
    }).map((item) => item.id));

    return {
      roots,
      trunks,
      branches,
      leaves,
      twigs,
      sticks,
      braces,
      knots,
      supportBraces,
    };
  }, [model?.id, supportBraceSnapshot.supportBraces, supportSnapshot.braces, supportSnapshot.branches, supportSnapshot.knots, supportSnapshot.leaves, supportSnapshot.roots, supportSnapshot.sticks, supportSnapshot.trunks, supportSnapshot.twigs]);

  React.useEffect(() => {
    if (!isOpen) return;
    setCollapsedGroups({});
  }, [isOpen, model?.id]);

  const summaryStats = React.useMemo(() => {
    return {
      roots: groups.roots.length,
      trunks: groups.trunks.length,
      branches: groups.branches.length,
      leaves: groups.leaves.length,
      twigs: groups.twigs.length,
      sticks: groups.sticks.length,
      braces: groups.braces.length,
      knots: groups.knots.length,
      supportBraces: groups.supportBraces.length,
    };
  }, [groups]);

  const totalSupportEntities = React.useMemo(() => {
    return summaryStats.roots
      + summaryStats.trunks
      + summaryStats.branches
      + summaryStats.leaves
      + summaryStats.twigs
      + summaryStats.sticks
      + summaryStats.braces
      + summaryStats.supportBraces;
  }, [summaryStats]);

  const groupRows = React.useMemo(() => {
    return [
      { key: 'roots', label: 'Roots', ids: groups.roots },
      { key: 'trunks', label: 'Trunks', ids: groups.trunks },
      { key: 'branches', label: 'Branches', ids: groups.branches },
      { key: 'leaves', label: 'Leaves', ids: groups.leaves },
      { key: 'twigs', label: 'Twigs', ids: groups.twigs },
      { key: 'sticks', label: 'Sticks', ids: groups.sticks },
      { key: 'braces', label: 'Braces', ids: groups.braces },
      { key: 'supportBraces', label: 'Support Braces', ids: groups.supportBraces },
      { key: 'knots', label: 'Knots', ids: groups.knots },
    ] as const;
  }, [groups]);

  const toggleGroup = React.useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[84vh] overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Model supports"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
              Model Supports
            </h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {model ? model.name : 'No model selected'}
            </p>
          </div>
          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Close supports modal"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[68vh] overflow-y-auto custom-scrollbar">
          <div
            className="rounded-md border px-3 py-2"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 58%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 92%)',
            }}
          >
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Total
            </div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {pluralize('support entity', totalSupportEntities)}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {[ 
              ['Roots', summaryStats.roots],
              ['Trunks', summaryStats.trunks],
              ['Branches', summaryStats.branches],
              ['Leaves', summaryStats.leaves],
              ['Twigs', summaryStats.twigs],
              ['Sticks', summaryStats.sticks],
              ['Braces', summaryStats.braces],
              ['Support Braces', summaryStats.supportBraces],
              ['Knots', summaryStats.knots],
            ].map(([label, count]) => (
              <div
                key={label}
                className="rounded-md border px-3 py-2"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                }}
              >
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
                <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                  {Number(count).toLocaleString()}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="px-1 pb-1 text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Support IDs by type
            </div>

            <div className="space-y-1">
              {groupRows.map((group) => {
                const isCollapsed = !!collapsedGroups[group.key];
                const isEmpty = group.ids.length === 0;

                return (
                  <div
                    key={group.key}
                    className="rounded border"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
                  >
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                      onClick={() => toggleGroup(group.key)}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                      )}
                      <span className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>{group.label}</span>
                      <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{group.ids.length}</span>
                    </button>

                    {!isCollapsed && (
                      <div className="border-t px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)' }}>
                        {isEmpty ? (
                          <div className="text-[11px] italic" style={{ color: 'var(--text-muted)' }}>
                            No {group.label.toLowerCase()} for this model.
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {group.ids.map((id) => (
                              <span
                                key={id}
                                className="rounded border px-1.5 py-0.5 text-[11px] font-mono"
                                style={{
                                  borderColor: 'var(--border-subtle)',
                                  color: 'var(--text-strong)',
                                  background: 'color-mix(in srgb, var(--surface-1), black 6%)',
                                }}
                                title={id}
                              >
                                {id}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}