'use client';

import React, { useState } from 'react';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { X, ChevronDown, ChevronRight } from 'lucide-react';

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

export function IslandHierarchyModal({ islands, isOpen, onClose, layerHeightMm, zOffsetMm }: IslandHierarchyModalProps) {
  React.useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: CustomEvent) => {
      if (event.detail.key === 'Escape') onClose();
    };

    window.addEventListener('app-hotkey-keydown', onKeyDown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', onKeyDown as EventListener);
  }, [isOpen, onClose]);

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
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>Island Hierarchy</h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Parent-child merges across detected islands
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
          {tree.length === 0 ? (
            <p className="text-center py-10 text-sm" style={{ color: 'var(--text-muted)' }}>No islands found.</p>
          ) : (
            <div className="space-y-2.5">
              {tree.map(node => (
                <TreeNodeComponent key={node.island.id} node={node} level={0} layerHeightMm={layerHeightMm} zOffsetMm={zOffsetMm} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-[11px] space-y-1" style={{ color: 'var(--text-muted)' }}>
            <p style={{ color: 'var(--text-strong)' }} className="font-semibold">Legend</p>
            <p>• Root islands have no parent (independent start)</p>
            <p>• Child islands merge upward into a parent node</p>
            <p>• Volume shows each island&apos;s individual contribution</p>
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
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  const layerRange = `L${node.island.firstLayer}-${node.island.lastLayer}`;
  const volume = node.island.volumeMm3?.toFixed(2) || '0.00';
  const layerCount = node.island.lastLayer - node.island.firstLayer + 1;
  const maxArea = node.island.maxAreaMm2?.toFixed(2) || '0.00';
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
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>({layerCount} layers)</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: 'var(--text-strong)' }}>{volume} mm³</span>
              {hasChildren && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                >
                  {node.children.length} {node.children.length === 1 ? 'child' : 'children'}
                </span>
              )}
            </div>
          </div>

          {/* Max area info */}
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Max area: {maxArea} mm² at L{worldMaxAreaLayer}
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
