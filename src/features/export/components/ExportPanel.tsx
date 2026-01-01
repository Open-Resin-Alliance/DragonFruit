import React, { useState } from 'react';
import * as THREE from 'three';
import { Download, FileDown, Settings2 } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { ExportManager, ExportOptions } from '../logic/ExportManager';

interface ExportPanelProps {
  activeModel: LoadedModel | null;
  supportsRef?: React.RefObject<THREE.Group | null>;
}

export function ExportPanel({ activeModel, supportsRef }: ExportPanelProps) {
  const [filename, setFilename] = useState(activeModel?.name?.replace('.stl', '') || 'MyPrint');
  const [isExporting, setIsExporting] = useState(false);
  
  // Export Options State
  const [options, setOptions] = useState<ExportOptions>({
    filename: '', // will be set on submit
    binary: true,
    separateFiles: false,
    includeRaft: true,
    includeSupports: true,
    includeModel: true,
  });

  const handleExport = async () => {
    if (!activeModel) return;
    
    setIsExporting(true);
    
    // Allow UI to update before freezing for export
    setTimeout(async () => {
      try {
        // 1. Prepare Model Mesh
        // We must replicate the StlMesh structure: Group(transform) -> Mesh(offset)
        // to ensure the model aligns with supports (which are in world space).
        const group = new THREE.Group();
        const t = activeModel.transform;
        group.position.copy(t.position);
        group.rotation.copy(t.rotation);
        group.scale.copy(t.scale);
        
        const centerOffset = activeModel.geometry.center;
        const mesh = new THREE.Mesh(activeModel.geometry.geometry);
        mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);
        
        group.add(mesh);
        group.updateMatrixWorld(true);

        // 2. Run Export
        // Pass the group and supports ref
        // Note: ExportManager.exportScene expects THREE.Mesh | null but STLExporter works on Object3D.
        // We should update ExportManager signature to accept Object3D to be safe, or cast here.
        await ExportManager.exportScene(
          group as unknown as THREE.Mesh, 
          supportsRef?.current || null,
          {
            ...options,
            filename: filename || 'export',
          }
        );
        
      } catch (err) {
        console.error('Export failed:', err);
        alert('Export failed. Check console for details.');
      } finally {
        setIsExporting(false);
      }
    }, 100);
  };

  if (!activeModel) {
    return (
      <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 text-[10px] text-neutral-400 text-center shadow-xl w-64">
        No model selected.
      </div>
    );
  }

  return (
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl w-64 space-y-2">
      <div className="flex items-center gap-1.5 py-1 border-b border-neutral-700">
        <FileDown className="w-3.5 h-3.5 text-blue-500" />
        <h2 className="text-xs font-semibold text-neutral-200">Export STL</h2>
      </div>

      {/* Filename */}
      <div className="space-y-0.5">
        <label className="text-[9px] text-neutral-400">Filename</label>
        <input
          type="text"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          className="w-full bg-neutral-700 border border-neutral-600 rounded px-1.5 py-0.5 text-xs text-neutral-200 focus:border-blue-500 outline-none"
          placeholder="filename"
        />
      </div>

      {/* Options */}
      <div className="space-y-1 bg-neutral-750 rounded p-1.5 border border-neutral-700/50">
        <div className="flex items-center gap-1 text-[9px] font-medium text-neutral-400 mb-1.5">
          <Settings2 className="w-3 h-3" />
          <span>Settings</span>
        </div>
        
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[10px] text-neutral-300">Include Model</span>
          <input
            type="checkbox"
            checked={options.includeModel}
            onChange={(e) => setOptions(prev => ({ ...prev, includeModel: e.target.checked }))}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[10px] text-neutral-300">Include Supports</span>
          <input
            type="checkbox"
            checked={options.includeSupports}
            onChange={(e) => setOptions(prev => ({ ...prev, includeSupports: e.target.checked }))}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[10px] text-neutral-300">Include Raft</span>
          <input
            type="checkbox"
            checked={options.includeRaft}
            onChange={(e) => setOptions(prev => ({ ...prev, includeRaft: e.target.checked }))}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <div className="h-px bg-neutral-700/50 my-1" />

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[10px] text-neutral-300">Binary Format</span>
          <input
            type="checkbox"
            checked={options.binary}
            onChange={(e) => setOptions(prev => ({ ...prev, binary: e.target.checked }))}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </div>

      {/* Action */}
      <button
        onClick={handleExport}
        disabled={isExporting}
        className={`
          w-full py-1.5 px-2 rounded text-xs font-medium flex items-center justify-center gap-1.5
          transition-all
          ${isExporting 
            ? 'bg-neutral-700 text-neutral-400 cursor-wait' 
            : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'}
        `}
      >
        {isExporting ? (
          <>
            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span>Exporting...</span>
          </>
        ) : (
          <>
            <Download className="w-3 h-3" />
            <span>Download STL</span>
          </>
        )}
      </button>
    </div>
  );
}

export default ExportPanel;
