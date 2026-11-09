'use client';

import React, { useState } from 'react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { IconButton } from '@/components/atoms';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';

type IslandHierarchyModalProps = {
  islands: Island[];
  isOpen: boolean;
  onClose: () => void;
  layerHeightMm: number;
  zOffsetMm: number;
};

type TreeNode = {
  island: Island;
  children: TreeNode[];
};

type Translate = (descriptor: MessageDescriptor) => string;

// Interpolating messages live at module level so React Compiler cannot rename their
// placeholders (see AGENTS.md).
function formatLayerCount(translate: Translate, count: number): string {
  return translate(msg({ message: plural(count, { one: '(# layer)', other: '(# layers)' }), comment: 'How many layers an island spans, shown in parentheses after its layer range.' }));
}

function formatChildCount(translate: Translate, count: number): string {
  return translate(msg({ message: plural(count, { one: '# child', other: '# children' }), comment: 'Badge on an island in the hierarchy: how many child islands merge into it.' }));
}

function formatMaxArea(translate: Translate, area: string, layer: number): string {
  return translate(msg({ message: `Max area: ${area} at L${layer}`, comment: '"L" abbreviates "layer", as in the L12-40 layer ranges beside it.' }));
}

export function IslandHierarchyModal({ islands, isOpen, onClose, layerHeightMm, zOffsetMm }: IslandHierarchyModalProps) {
  const { _ } = useLingui();
  useEscapeToClose(isOpen, onClose);

  if (!isOpen) return null;

  // Build tree structure - find root islands (no parent)
  const buildTree = (): TreeNode[] => {
    const rootIslands = islands.filter(i => !i.parentId);

    const buildNode = (island: Island): TreeNode => {
      const children = islands
        .filter(i => i.parentId === island.id)
        .map(child => buildNode(child));

      return { island, children };
    };

    return rootIslands.map(root => buildNode(root));
  };

  const tree = buildTree();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-3xl max-h-[84vh] flex flex-col rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Island Hierarchy</Trans></h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Parent-child merges across detected islands</Trans>
            </p>
          </div>
          <IconButton
            variant="surface"
            size="sm"
            onClick={onClose}
            aria-label={_(msg`Close`)}
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
          {tree.length === 0 ? (
            <p className="text-center py-10 text-sm" style={{ color: 'var(--text-muted)' }}><Trans>No islands found.</Trans></p>
          ) : (
            <div className="space-y-2.5">
              {tree.map(node => (
                <TreeNodeComponent key={node.island.id} node={node} level={0} layerHeightMm={layerHeightMm} zOffsetMm={zOffsetMm} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-[11px] space-y-1" style={{ color: 'var(--text-muted)' }}>
            <p style={{ color: 'var(--text-strong)' }} className="font-semibold"><Trans>Legend</Trans></p>
            <p><Trans>• Root islands have no parent (independent start)</Trans></p>
            <p><Trans>• Child islands merge upward into a parent node</Trans></p>
            <p><Trans>• Volume shows each island’s individual contribution</Trans></p>
          </div>
        </div>
      </div>
    </div>
  );
}

type TreeNodeComponentProps = {
  node: TreeNode;
  level: number;
  layerHeightMm: number;
  zOffsetMm: number;
};

function TreeNodeComponent({ node, level, layerHeightMm, zOffsetMm }: TreeNodeComponentProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  const layerRange = `L${node.island.firstLayer}-${node.island.lastLayer}`;
  const volume = fmt.quantity(node.island.volumeMm3 ?? 0, 2, 'mm3');
  const layerCount = node.island.lastLayer - node.island.firstLayer + 1;
  const maxArea = fmt.quantity(node.island.maxAreaMm2 ?? 0, 2, 'mm2');
  const maxAreaLayer = node.island.maxAreaLayer ?? 0;
  const worldMaxAreaLayer = Math.round(maxAreaLayer + (zOffsetMm / layerHeightMm));

  return (
    <div className="relative">
      {/* Connecting Lines */}
      {level > 0 && (
        <>
          {/* Horizontal line to node */}
          <div
            className="absolute top-7 border-t"
            style={{
              left: `${(level - 1) * 32 + 16}px`,
              width: '24px',
              borderColor: 'var(--border-subtle)',
            }}
          />
          {/* Vertical line from parent */}
          <div
            className="absolute top-0 bottom-0 border-l"
            style={{
              left: `${(level - 1) * 32 + 16}px`,
              height: '28px',
              borderColor: 'var(--border-subtle)',
            }}
          />
        </>
      )}

      {/* Node */}
      <div
        className="flex items-center gap-2 p-2 rounded-md transition-colors relative border"
        style={{
          paddingLeft: `${level * 32 + 8}px`,
          background: 'var(--surface-1)',
          borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 20%)',
        }}
      >
        {/* Expand/Collapse Button */}
        {hasChildren ? (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-6 w-6 inline-flex items-center justify-center rounded border transition-colors z-10"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            ) : (
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            )}
          </button>
        ) : (
          <div className="w-6" />
        )}

        {/* Island Info */}
        <div className="flex-1 relative z-10">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-bold" style={{ color: 'var(--accent)' }}>#{node.island.id}</span>
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{layerRange}</span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatLayerCount(_, layerCount)}</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: 'var(--text-strong)' }}>{volume}</span>
              {hasChildren && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                >
                  {formatChildCount(_, node.children.length)}
                </span>
              )}
            </div>
          </div>

          {/* Max area info */}
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
            {formatMaxArea(_, maxArea, worldMaxAreaLayer)}
          </div>
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="relative">
          {/* Vertical line for children */}
          <div
            className="absolute border-l"
            style={{
              left: `${level * 32 + 16}px`,
              top: '0',
              bottom: '12px',
              borderColor: 'var(--border-subtle)',
            }}
          />
          {node.children.map((child) => (
            <TreeNodeComponent key={child.island.id} node={child} level={level + 1} layerHeightMm={layerHeightMm} zOffsetMm={zOffsetMm} />
          ))}
        </div>
      )}
    </div>
  );
}
