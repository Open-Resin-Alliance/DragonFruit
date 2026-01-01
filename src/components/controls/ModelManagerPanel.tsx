import React, { useState } from 'react';
import { Eye, EyeOff, Trash2, Box } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

interface ModelManagerPanelProps {
  models: LoadedModel[];
  activeModelId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;
}

export function ModelManagerPanel({
  models,
  activeModelId,
  onSelect,
  onDelete,
  onVisibilityChange
}: ModelManagerPanelProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl">
      <div className="flex items-center justify-between py-1 border-b border-neutral-700 mb-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg
              className={`w-3 h-3 ${expanded ? 'text-blue-500' : 'text-neutral-500'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <h3 className="text-xs font-semibold text-neutral-200">Models</h3>
        </div>
        <div className="text-[9px] text-neutral-400">
            {models.length}
        </div>
      </div>

      {expanded && (
        <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
          {models.length === 0 ? (
            <div className="text-[10px] text-neutral-500 text-center py-2 italic">
              No models loaded
            </div>
          ) : (
            models.map((model) => {
              const isActive = model.id === activeModelId;
              return (
                <div
                  key={model.id}
                  className={`p-1.5 rounded border transition-colors flex items-center gap-2 cursor-pointer ${
                    isActive
                      ? 'bg-blue-500/10 border-blue-500/50'
                      : 'bg-neutral-750 border-transparent hover:bg-neutral-700'
                  }`}
                  onClick={() => onSelect(model.id)}
                >
                  {/* Icon */}
                  <div className={`p-1 rounded ${isActive ? 'bg-blue-500/20 text-blue-400' : 'bg-neutral-700 text-neutral-400'}`}>
                    <Box className="w-3 h-3" />
                  </div>
                  
                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium truncate ${isActive ? 'text-blue-100' : 'text-neutral-300'}`}>
                      {model.name}
                    </div>
                    <div className="text-[9px] text-neutral-500">
                      {model.polygonCount.toLocaleString()} polys
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-0.5">
                     <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onVisibilityChange(model.id, !model.visible);
                        }}
                        className={`p-1 rounded hover:bg-neutral-600 transition-colors ${model.visible ? 'text-neutral-400' : 'text-neutral-600'}`}
                        title={model.visible ? 'Hide' : 'Show'}
                     >
                        {model.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                     </button>
                     <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(model.id);
                        }}
                        className="p-1 rounded hover:bg-red-900/50 text-neutral-500 hover:text-red-400 transition-colors"
                        title="Delete model"
                     >
                        <Trash2 className="w-3 h-3" />
                     </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
