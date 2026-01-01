'use client';

import React, { useState } from 'react';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { getIslandHierarchy } from '@/volumeAnalysis/VoxelSystem/IslandVolume';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-neutral-900 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col border border-neutral-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <h2 className="text-lg font-semibold text-white">Island Hierarchy</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-neutral-800 rounded transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-neutral-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tree.length === 0 ? (
            <p className="text-neutral-400 text-center py-8">No islands found</p>
          ) : (
            <div className="space-y-2">
              {tree.map(node => (
                <TreeNodeComponent key={node.island.id} node={node} level={0} layerHeightMm={layerHeightMm} zOffsetMm={zOffsetMm} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-neutral-700 bg-neutral-800/50">
          <div className="text-xs text-neutral-400 space-y-1">
            <p><strong>Legend:</strong></p>
            <p>• Root islands have no parent (started independently)</p>
            <p>• Child islands merged into their parent</p>
            <p>• Volume shows individual island contribution</p>
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
            className="absolute top-6 border-t-2 border-neutral-600"
            style={{
              left: `${(level - 1) * 32 + 16}px`,
              width: '24px'
            }}
          />
          {/* Vertical line from parent */}
          <div
            className="absolute top-0 bottom-0 border-l-2 border-neutral-600"
            style={{
              left: `${(level - 1) * 32 + 16}px`,
              height: '24px'
            }}
          />
        </>
      )}

      {/* Node */}
      <div
        className="flex items-center gap-2 p-2 rounded hover:bg-neutral-800 transition-colors relative"
        style={{ paddingLeft: `${level * 32 + 8}px` }}
      >
        {/* Expand/Collapse Button */}
        {hasChildren ? (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors z-10 bg-neutral-900"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-neutral-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-neutral-400" />
            )}
          </button>
        ) : (
          <div className="w-5" /> // Spacer for alignment
        )}

        {/* Island Info */}
        <div className="flex-1 bg-neutral-900 relative z-10">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="font-mono font-bold text-blue-400">#{node.island.id}</span>
              <span className="text-xs text-neutral-500 font-mono">{layerRange}</span>
              <span className="text-xs text-neutral-400">({layerCount} layers)</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-300">{volume} mm³</span>
              {hasChildren && (
                <span className="text-xs text-neutral-500 bg-neutral-800 px-2 py-0.5 rounded">
                  {node.children.length} {node.children.length === 1 ? 'child' : 'children'}
                </span>
              )}
            </div>
          </div>

          {/* Max area info */}
          <div className="text-[10px] text-neutral-500 mt-1">
            Max area: {maxArea} mm² at L{worldMaxAreaLayer}
          </div>
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="relative">
          {/* Vertical line for children */}
          <div
            className="absolute border-l-2 border-neutral-600"
            style={{
              left: `${level * 32 + 16}px`,
              top: '0',
              bottom: '12px'
            }}
          />
          {node.children.map((child, index) => (
            <TreeNodeComponent key={child.island.id} node={child} level={level + 1} layerHeightMm={layerHeightMm} zOffsetMm={zOffsetMm} />
          ))}
        </div>
      )}
    </div>
  );
}
