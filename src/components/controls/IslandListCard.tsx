
import React, { useState } from 'react';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { IslandHierarchyModal } from '@/components/modals/IslandHierarchyModal';
import { ChevronRight, Network } from 'lucide-react';
import { Button, Card, CardHeader, IconButton, Input } from '@/components/ui/primitives';

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
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'id' | 'volume' | 'layers'>('id');
  const [showHierarchyModal, setShowHierarchyModal] = useState(false);
  const [compactHeader, setCompactHeader] = useState(false);

  React.useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;

    const updateCompactState = () => {
      setCompactHeader(element.clientWidth <= 286);
    };

    updateCompactState();
    const observer = new ResizeObserver(updateCompactState);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // Separate active islands
  const activeIslands = islands.filter(i => i.status === 'active');

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
    <div ref={cardRef}>
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              className="!p-0.5"
              title={expanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
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
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island IDs</h3>
          </>
        )}
        right={(
          <Button
            onClick={() => setShowHierarchyModal(true)}
            variant="accent"
            size="sm"
            className={compactHeader ? '!h-9 !px-2 !py-0 text-[12px] font-semibold' : '!h-9 !px-2.5 !py-0 text-[12px] font-semibold'}
            title="View island hierarchy tree"
          >
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {!compactHeader && (
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent-secondary-contrast), transparent 45%)',
                    background: 'color-mix(in srgb, var(--accent-secondary-contrast), transparent 86%)',
                  }}
                >
                  <Network className="h-3.5 w-3.5" style={{ color: 'var(--accent-secondary-contrast)' }} />
                </span>
              )}
              <span className="leading-none" style={{ color: 'var(--accent-secondary-contrast)' }}>Hierarchy</span>
              {!compactHeader && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, var(--accent-secondary-contrast), transparent 18%)' }} />
              )}
            </span>
          </Button>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-1.5">
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded p-1" style={{ background: 'var(--surface-1)' }}>
              <div className="ui-meta">Total Islands</div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{islands.length}</div>
            </div>
            <div className="rounded p-1" style={{ background: 'var(--surface-1)' }}>
              <div className="ui-meta">Active</div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{activeIslands.length}</div>
            </div>
          </div>

          {/* Show merged toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer py-0.5 px-0.5">
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(e) => onShowMergedChange(e.target.checked)}
              className="ui-checkbox"
            />
            <span className="ui-meta">Show child islands</span>
          </label>

          {/* Search and sort */}
          <div className="space-y-1">
            <Input
              type="text"
              placeholder="Search island ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full !h-8 px-2 text-sm no-spinners"
            />
            <div className="flex gap-1">
              <button
                onClick={() => setSortBy('id')}
                className={`ui-button flex-1 !h-8 px-2 py-0 text-[11px] ${sortBy === 'id' ? 'ui-button-primary' : 'ui-button-secondary'}`}
              >
                ID
              </button>
              <button
                onClick={() => setSortBy('volume')}
                className={`ui-button flex-1 !h-8 px-2 py-0 text-[11px] ${sortBy === 'volume' ? 'ui-button-primary' : 'ui-button-secondary'}`}
              >
                Volume
              </button>
              <button
                onClick={() => setSortBy('layers')}
                className={`ui-button flex-1 !h-8 px-2 py-0 text-[11px] ${sortBy === 'layers' ? 'ui-button-primary' : 'ui-button-secondary'}`}
              >
                Layers
              </button>
            </div>
          </div>

          {/* Island list */}
          <div className="space-y-1 max-h-[30rem] overflow-y-auto custom-scrollbar">
            <div className="ui-meta px-1">
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
                  className={`p-1.5 rounded cursor-pointer transition-colors border ${
                    isSelected ? '' : 'hover:bg-black/10'
                  }`}
                  style={isSelected
                    ? {
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                      }
                    : { background: 'var(--surface-1)', borderColor: 'transparent' }}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                        <span className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                          #{island.id}
                        </span>
                        {island.childIds.length > 0 && (
                          <span className="text-[10px] px-1 py-0.5 bg-green-500/20 text-green-400 rounded leading-none">
                            P+{island.childIds.length}
                          </span>
                        )}
                        {isMerged && island.parentId && (
                          <span className="text-[10px] px-1 py-0.5 bg-orange-500/20 text-orange-400 rounded leading-none">
                            C#{island.parentId}
                          </span>
                        )}
                      </div>
                      <div className="ui-meta leading-tight">
                        L{island.firstLayer}–{island.lastLayer} ({layerSpan})
                      </div>
                      <div className="ui-meta leading-tight">
                        {island.volumeMm3 !== undefined
                          ? `${island.volumeMm3.toFixed(2)} mm³`
                          : `${island.totalAreaMm2.toFixed(1)} mm²`}
                      </div>
                      {island.maxAreaMm2 !== undefined && island.maxAreaLayer !== undefined && (
                        <div className="ui-meta leading-tight" style={{ color: 'color-mix(in srgb, var(--text-muted), black 20%)' }}>
                          Max: {island.maxAreaMm2.toFixed(2)} mm² @ L{Math.round(island.maxAreaLayer + (zOffsetMm / layerHeightMm))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Show parent info */}
                  {isMerged && island.parentId && (
                    <div className="ui-meta mt-1 border-t pt-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                      → Child of #{island.parentId}
                    </div>
                  )}
                  {island.childIds.length > 0 && (
                    <div className="ui-meta mt-1 border-t pt-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                      Children: {island.childIds.map(id => `#${id} `).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Clear selection button */}
          {selectedIslandId !== null && (
            <Button
              onClick={() => onSelectIsland(null)}
              className="w-full !h-8 px-2.5 py-0 text-[11px]"
              size="sm"
            >
              Clear Selection
            </Button>
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
    </Card>
    </div>
  );
}
