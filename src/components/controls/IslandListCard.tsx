
import React, { useState } from 'react';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { IslandHierarchyModal } from '@/components/modals/IslandHierarchyModal';
import { getIslandHierarchy } from '@/volumeAnalysis/VoxelSystem/IslandVolume';
import { Network } from 'lucide-react';

type IslandListCardProps = {
  islands: Island[];
  selectedIslandId: number | null;
  onSelectIsland: (id: number | null) => void;
  showMerged: boolean;
  onShowMergedChange: (show: boolean) => void;
  layerHeightMm: number;
  zOffsetMm: number;
};

/**
 * Standalone card showing list of detected islands with search and sort.
 * Separated from volume visualization controls.
 */
export function IslandListCard({
  islands,
  selectedIslandId,
  onSelectIsland,
  showMerged,
  onShowMergedChange,
  layerHeightMm,
  zOffsetMm,
}: IslandListCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'id' | 'volume' | 'layers'>('id');
  const [showHierarchyModal, setShowHierarchyModal] = useState(false);

  // Separate active and child islands
  const activeIslands = islands.filter(i => i.status === 'active');
  const childIslands = islands.filter(i => i.status === 'complete');

  // Filter and sort islands
  const filteredIslands = (showMerged ? islands : activeIslands).filter(island => {
    if (!searchTerm) return true;
    return island.id.toString().includes(searchTerm);
  });

  const sortedIslands = [...filteredIslands].sort((a, b) => {
    if (sortBy === 'id') return a.id - b.id;
    if (sortBy === 'volume') {
      const volA = a.volumeMm3 ?? a.totalAreaMm2;
      const volB = b.volumeMm3 ?? b.totalAreaMm2;
      return volB - volA; // Descending
    }
    if (sortBy === 'layers') return (b.lastLayer - b.firstLayer) - (a.lastLayer - a.firstLayer);
    return 0;
  });

  return (
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between py-1 border-b border-neutral-700 mb-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg
              className={`w-3 h-3 transform transition-transform ${expanded ? 'text-blue-500' : 'text-neutral-500'} `}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              {expanded ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              )}
            </svg>
          </button>
          <h3 className="text-xs font-semibold text-neutral-200">Island IDs</h3>
        </div>

        {/* Hierarchy Button */}
        <button
          onClick={() => setShowHierarchyModal(true)}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded transition-colors"
          title="View island hierarchy tree"
        >
          <Network className="w-3 h-3" />
          <span>Hierarchy</span>
        </button>
      </div>

      {expanded && (
        <div className="space-y-1">
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-1.5 text-[9px]">
            <div className="bg-neutral-750 rounded p-1">
              <div className="text-neutral-400">Total Islands</div>
              <div className="text-neutral-200 font-semibold">{islands.length}</div>
            </div>
            <div className="bg-neutral-750 rounded p-1">
              <div className="text-neutral-400">Active</div>
              <div className="text-neutral-200 font-semibold">{activeIslands.length}</div>
            </div>
          </div>

          {/* Show merged toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer py-0.5">
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(e) => onShowMergedChange(e.target.checked)}
              className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500 focus:ring-offset-0"
            />
            <span className="text-[10px] text-neutral-400">Show child islands</span>
          </label>

          {/* Search and sort */}
          <div className="space-y-1">
            <input
              type="text"
              placeholder="Search island ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-blue-500 no-spinners"
            />
            <div className="flex gap-1">
              <button
                onClick={() => setSortBy('id')}
                className={`flex - 1 px - 1.5 py - 0.5 text - [10px] rounded ${sortBy === 'id'
                  ? 'bg-blue-500 text-white'
                  : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  } `}
              >
                ID
              </button>
              <button
                onClick={() => setSortBy('volume')}
                className={`flex - 1 px - 1.5 py - 0.5 text - [10px] rounded ${sortBy === 'volume'
                  ? 'bg-blue-500 text-white'
                  : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  } `}
              >
                Volume
              </button>
              <button
                onClick={() => setSortBy('layers')}
                className={`flex - 1 px - 1.5 py - 0.5 text - [10px] rounded ${sortBy === 'layers'
                  ? 'bg-blue-500 text-white'
                  : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  } `}
              >
                Layers
              </button>
            </div>
          </div>

          {/* Island list */}
          <div className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
            <div className="text-[9px] text-neutral-400 px-1">
              {sortedIslands.length} island{sortedIslands.length !== 1 ? 's' : ''}
            </div>
            {sortedIslands.map((island) => {
              const layerSpan = island.lastLayer - island.firstLayer + 1;
              const isSelected = island.id === selectedIslandId;
              const isMerged = island.status === 'complete';

              return (
                <div
                  key={island.id}
                  onClick={() => onSelectIsland(isSelected ? null : island.id)}
                  className={`p - 1.5 rounded cursor - pointer transition - colors ${isSelected
                    ? 'bg-blue-500/20 border border-blue-500'
                    : 'bg-neutral-750 border border-transparent hover:bg-neutral-700'
                    } `}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                        <span className="text-xs font-semibold text-neutral-200">
                          #{island.id}
                        </span>
                        {island.childIds.length > 0 && (
                          <span className="text-[9px] px-1 py-0.5 bg-green-500/20 text-green-400 rounded leading-none">
                            P+{island.childIds.length}
                          </span>
                        )}
                        {isMerged && island.parentId && (
                          <span className="text-[9px] px-1 py-0.5 bg-orange-500/20 text-orange-400 rounded leading-none">
                            C#{island.parentId}
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] text-neutral-400 leading-tight">
                        L{island.firstLayer}–{island.lastLayer} ({layerSpan})
                      </div>
                      <div className="text-[9px] text-neutral-400 leading-tight">
                        {island.volumeMm3 !== undefined
                          ? `${island.volumeMm3.toFixed(2)} mm³`
                          : `${island.totalAreaMm2.toFixed(1)} mm²`}
                      </div>
                      {island.maxAreaMm2 !== undefined && island.maxAreaLayer !== undefined && (
                        <div className="text-[9px] text-neutral-500 leading-tight">
                          Max: {island.maxAreaMm2.toFixed(2)} mm² @ L{Math.round(island.maxAreaLayer + (zOffsetMm / layerHeightMm))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Show parent info */}
                  {isMerged && island.parentId && (
                    <div className="text-[9px] text-neutral-500 mt-1 border-t border-neutral-600 pt-0.5">
                      → Child of #{island.parentId}
                    </div>
                  )}
                  {island.childIds.length > 0 && (
                    <div className="text-[9px] text-neutral-500 mt-1 border-t border-neutral-600 pt-0.5">
                      Children: {island.childIds.map(id => `#${id} `).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Clear selection button */}
          {selectedIslandId !== null && (
            <button
              onClick={() => onSelectIsland(null)}
              className="w-full px-2 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded transition-colors"
            >
              Clear Selection
            </button>
          )}
        </div>
      )}

      {/* Hierarchy Modal */}
      <IslandHierarchyModal
        islands={islands}
        isOpen={showHierarchyModal}
        onClose={() => setShowHierarchyModal(false)}
        layerHeightMm={layerHeightMm}
        zOffsetMm={zOffsetMm}
      />
    </div>
  );
}
