'use client';

import React, { useState, useEffect } from 'react';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { HotkeyBinding, UNIVERSAL_HOTKEYS } from '@/hotkeys/hotkeyConfig';
import { getPresetList, subscribeToPresets } from '@/supports/Settings/presets';

const PRESET_ACTION_TO_ID: Record<string, string> = {
  APPLY_DETAIL: 'detail',
  APPLY_STRUCTURE: 'structure',
  APPLY_ANCHOR: 'anchor',
  APPLY_CUSTOM_1: 'custom1',
  APPLY_CUSTOM_2: 'custom2',
  APPLY_CUSTOM_3: 'custom3',
};

export function HotkeysSettingsTab() {
  const { config, updateHotkey, resetToDefaults } = useHotkeyConfig();
  const [recordingKey, setRecordingKey] = useState<{ category: string, action: string } | null>(null);
  const [presetNames, setPresetNames] = useState<Record<string, string>>({});

  // Subscribe to preset changes to keep labels in sync
  useEffect(() => {
    const updateNames = () => {
      const list = getPresetList();
      const map: Record<string, string> = {};
      list.forEach(p => map[p.id] = p.name);
      setPresetNames(map);
    };

    updateNames();
    return subscribeToPresets(updateNames);
  }, []);

  // Effect to handle key recording
  useEffect(() => {
    if (!recordingKey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push('ctrl');
      if (e.shiftKey) modifiers.push('shift');
      if (e.altKey) modifiers.push('alt');
      if (e.metaKey) modifiers.push('meta');

      // If only modifiers are pressed, don't save yet (wait for the main key)
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const newUnnormalizedKey = e.key;
      // Normalize key for display/storage if needed (e.g. ' ' -> 'Space')
      const finalKey = newUnnormalizedKey === ' ' ? 'Space' : newUnnormalizedKey;

      const newBinding: HotkeyBinding = {
        key: finalKey,
        modifier: modifiers.length > 0 ? modifiers.join('+') : undefined,
        description: config[recordingKey.category][recordingKey.action].description
      };

      updateHotkey(recordingKey.category, recordingKey.action, newBinding);
      setRecordingKey(null);
    };

    window.addEventListener('keydown', handleKeyDown, true); // Capture phase to prevent other app hotkeys
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingKey, config, updateHotkey]);


  return (
    <div className="space-y-6 text-sm text-neutral-300 p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">Keyboard Shortcuts</h2>
        <button
          onClick={resetToDefaults}
          className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-400 transition-colors"
        >
          Reset to Defaults
        </button>
      </div>

      {/* General App Section (Universal / Shared) */}
      <section className="space-y-3">
        <h3 className="uppercase text-xs font-bold tracking-wider text-neutral-500 border-b border-neutral-800 pb-1">
          General & Canvas
        </h3>

        {/* Universal Hotkeys (Read-Only) */}
        {Object.entries(UNIVERSAL_HOTKEYS).map(([key, binding]) => (
          <div key={key} className="flex justify-between items-center py-1 opacity-60" title="System standard - cannot be changed">
            <span>{binding.description}</span>
            <div className="flex gap-1">
              {binding.modifier && <Kbd>{binding.modifier}</Kbd>}
              {(binding as any).keys ? (
                (binding as any).keys.map((k: string) => <Kbd key={k}>{k}</Kbd>)
              ) : (
                <Kbd>{(binding as any).key}</Kbd>
              )}
            </div>
          </div>
        ))}

        {/* Configurable Camera/Canvas Hotkeys */}
        {config.CAMERA && Object.entries(config.CAMERA).map(([action, binding]) => (
          <HotkeyRow
            key={action}
            label={binding.description}
            binding={binding}
            isRecording={recordingKey?.category === 'CAMERA' && recordingKey?.action === action}
            onRecord={() => setRecordingKey({ category: 'CAMERA', action })}
            onCancel={() => setRecordingKey(null)}
          />
        ))}

        {config.CANVAS && (
          <div className="pt-1">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 mb-1">Canvas Tools</div>
            {Object.entries(config.CANVAS).map(([action, binding]) => (
              <HotkeyRow
                key={action}
                label={binding.description}
                binding={binding}
                isRecording={recordingKey?.category === 'CANVAS' && recordingKey?.action === action}
                onRecord={() => setRecordingKey({ category: 'CANVAS', action })}
                onCancel={() => setRecordingKey(null)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Supports Section */}
      <section className="space-y-3">
        <h3 className="uppercase text-xs font-bold tracking-wider text-neutral-500 border-b border-neutral-800 pb-1">
          Supports
        </h3>
        {config.SUPPORTS && Object.entries(config.SUPPORTS).map(([action, binding]) => (
          <HotkeyRow
            key={action}
            label={binding.description}
            binding={binding}
            isRecording={recordingKey?.category === 'SUPPORTS' && recordingKey?.action === action}
            onRecord={() => setRecordingKey({ category: 'SUPPORTS', action })}
            onCancel={() => setRecordingKey(null)}
          />
        ))}
      </section>

      {/* Presets Section */}
      <section className="space-y-3">
        <h3 className="uppercase text-xs font-bold tracking-wider text-neutral-500 border-b border-neutral-800 pb-1">
          Presets
        </h3>
        {config.PRESETS && Object.entries(config.PRESETS).map(([action, binding]) => {
          const presetId = PRESET_ACTION_TO_ID[action];
          const presetName = presetId ? presetNames[presetId] : null;
          const displayLabel = presetName ? `Apply "${presetName}" Preset` : binding.description;

          return (
            <HotkeyRow
              key={action}
              label={displayLabel}
              binding={binding}
              isRecording={recordingKey?.category === 'PRESETS' && recordingKey?.action === action}
              onRecord={() => setRecordingKey({ category: 'PRESETS', action })}
              onCancel={() => setRecordingKey(null)}
            />
          );
        })}
      </section>

      {/* Recording Overlay/Hint */}
      {recordingKey && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center cursor-wait backdrop-blur-sm"
          onClick={() => setRecordingKey(null)}>
          <div className="bg-neutral-900 border border-neutral-700 p-6 rounded-lg shadow-2xl text-center">
            <p className="text-xl font-medium text-white mb-2">Recording Hotkey</p>
            <p className="text-neutral-400">Press the new key combination...</p>
            <p className="text-xs text-neutral-600 mt-4">Click anywhere to cancel</p>
          </div>
        </div>
      )}
    </div>
  );
}

function HotkeyRow({ label, binding, isRecording, onRecord, onCancel }: {
  label: string,
  binding: HotkeyBinding,
  isRecording: boolean,
  onRecord: () => void,
  onCancel: () => void
}) {
  return (
    <div className="flex justify-between items-center py-1 group hover:bg-neutral-800/30 rounded px-2 -mx-2 transition-colors">
      <span>{label}</span>
      <button
        onClick={(e) => { e.stopPropagation(); isRecording ? onCancel() : onRecord(); }}
        className={`flex gap-1 items-center px-1.5 py-0.5 rounded border min-w-[60px] justify-center transition-all ${isRecording
          ? 'bg-blue-900/50 border-blue-500 text-blue-200 animate-pulse'
          : 'bg-neutral-800 border-neutral-700 hover:border-neutral-500'
          }`}
      >
        {isRecording ? (
          <span className="text-xs font-medium">Press keys...</span>
        ) : (
          <>
            {binding.modifier && <span className="text-neutral-400 font-mono text-xs">{binding.modifier} +</span>}
            <span className="font-mono font-bold text-xs">{binding.key}</span>
          </>
        )}
      </button>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 font-mono text-xs text-neutral-400 min-w-[20px] text-center inline-block">
      {children}
    </kbd>
  );
}
