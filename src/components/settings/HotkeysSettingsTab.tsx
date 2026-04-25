'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { Keyboard, Lock, RotateCcw } from 'lucide-react';
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

const CATEGORY_LABELS: Record<string, string> = {
  CAMERA: 'Camera',
  CANVAS: 'Canvas Tools',
  SUPPORTS: 'Supports',
  PRESETS: 'Presets',
  ROTATION: 'Rotation',
};

const SECTION_GROUPS: Array<{
  id: string;
  title: string;
  description: string;
  categories: string[];
}> = [
  {
    id: 'navigation',
    title: 'Navigation & Workspace',
    description: 'Focus, projection, and canvas tool switching.',
    categories: ['CAMERA', 'CANVAS'],
  },
  {
    id: 'supports',
    title: 'Support Authoring',
    description: 'Placement modes and support workflow shortcuts.',
    categories: ['SUPPORTS'],
  },
  {
    id: 'presets',
    title: 'Preset Actions',
    description: 'Quick-apply detail, structure, anchor, and custom presets.',
    categories: ['PRESETS'],
  },
  {
    id: 'rotation',
    title: 'Rotation Helpers',
    description: 'Modifier-assisted snapping during rotation drag.',
    categories: ['ROTATION'],
  },
];

function toModifierLabel(modifier: string): string {
  const normalized = modifier.trim().toLowerCase();
  if (normalized === 'ctrl') return 'Ctrl';
  if (normalized === 'shift') return 'Shift';
  if (normalized === 'alt') return 'Alt';
  if (normalized === 'meta') return 'Meta';
  return modifier;
}

function toKeyLabel(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key.toLowerCase() === ' ') return 'Space';
  return key;
}

function normalizeRecordedKey(rawKey: string): string {
  if (rawKey === ' ') return 'Space';
  return rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
}

function getBindingTokens(binding: HotkeyBinding): string[] {
  const modifierTokens = binding.modifier
    ? binding.modifier.split('+').map(toModifierLabel)
    : [];
  return [...modifierTokens, toKeyLabel(binding.key)];
}

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

      if (e.repeat) return;

      if (e.key === 'Escape') {
        setRecordingKey(null);
        return;
      }

      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push('ctrl');
      if (e.shiftKey) modifiers.push('shift');
      if (e.altKey) modifiers.push('alt');
      if (e.metaKey) modifiers.push('meta');

      // If only modifiers are pressed, don't save yet (wait for the main key)
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const finalKey = normalizeRecordedKey(e.key);

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

  const configurableSections = useMemo(() => {
    return SECTION_GROUPS.map((section) => {
      const categories = section.categories
        .map((category) => {
          const categoryConfig = config[category];
          if (!categoryConfig) return null;

          const entries = Object.entries(categoryConfig).map(([action, binding]) => {
            if (category !== 'PRESETS') {
              return { action, label: binding.description, binding };
            }

            const presetId = PRESET_ACTION_TO_ID[action];
            const presetName = presetId ? presetNames[presetId] : null;
            return {
              action,
              label: presetName ? `Apply \"${presetName}\" Preset` : binding.description,
              binding,
            };
          });

          return {
            category,
            categoryLabel: CATEGORY_LABELS[category] ?? category,
            entries,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      return {
        ...section,
        categories,
      };
    }).filter((section) => section.categories.some((category) => category.entries.length > 0));
  }, [config, presetNames]);

  const universalRows = useMemo(() => {
    return Object.entries(UNIVERSAL_HOTKEYS).map(([action, binding]) => {
      if ('keys' in binding) {
        return {
          action,
          label: binding.description,
          tokenGroups: binding.keys.map((key) => [toKeyLabel(key)]),
        };
      }

      const modifierTokens = binding.modifier
        ? binding.modifier.split('+').map(toModifierLabel)
        : [];

      return {
        action,
        label: binding.description,
        tokenGroups: [[...modifierTokens, toKeyLabel(binding.key)]],
      };
    });
  }, []);

  const rotationSection = useMemo(
    () => configurableSections.find((section) => section.id === 'rotation') ?? null,
    [configurableSections],
  );

  const nonRotationSections = useMemo(
    () => configurableSections.filter((section) => section.id !== 'rotation'),
    [configurableSections],
  );

  const navigationSection = useMemo(
    () => nonRotationSections.find((section) => section.id === 'navigation') ?? null,
    [nonRotationSections],
  );

  const supportSection = useMemo(
    () => nonRotationSections.find((section) => section.id === 'supports') ?? null,
    [nonRotationSections],
  );

  const presetSection = useMemo(
    () => nonRotationSections.find((section) => section.id === 'presets') ?? null,
    [nonRotationSections],
  );

  const extraNonRotationSections = useMemo(
    () => nonRotationSections.filter((section) => !['navigation', 'supports', 'presets'].includes(section.id)),
    [nonRotationSections],
  );

  const [firstExtraSection, ...remainingExtraSections] = extraNonRotationSections;

  const remainingExtraRows = useMemo(() => {
    const rows: Array<[typeof remainingExtraSections[number] | null, typeof remainingExtraSections[number] | null]> = [];
    for (let index = 0; index < remainingExtraSections.length; index += 2) {
      rows.push([
        remainingExtraSections[index] ?? null,
        remainingExtraSections[index + 1] ?? null,
      ]);
    }
    return rows;
  }, [remainingExtraSections]);

  const renderConfigSection = (section: {
    id: string;
    title: string;
    description: string;
    categories: Array<{
      category: string;
      categoryLabel: string;
      entries: Array<{
        action: string;
        label: string;
        binding: HotkeyBinding;
      }>;
    }>;
  }) => (
    <section
      key={section.id}
      className="rounded-lg border p-2.5 h-full"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-1)',
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
          }}
        >
          <Keyboard className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            {section.title}
          </h4>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {section.description}
          </p>
        </div>
      </div>

      <div className="mt-2 space-y-2">
        {section.categories.map((category) => (
          <div key={`${section.id}-${category.category}`} className="space-y-1">
            {section.categories.length > 1 && (
              <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {category.categoryLabel}
              </div>
            )}

            {category.entries.map((entry) => (
              <HotkeyRow
                key={`${category.category}-${entry.action}`}
                label={entry.label}
                binding={entry.binding}
                isRecording={recordingKey?.category === category.category && recordingKey?.action === entry.action}
                onRecord={() => setRecordingKey({ category: category.category, action: entry.action })}
                onCancel={() => setRecordingKey(null)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );


  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <div className="px-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        Click a shortcut chip to record a new key combo. Press <strong>Esc</strong> while recording to cancel.
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
        <div className="space-y-2.5">
          {(navigationSection || supportSection) && (
            <div className="grid gap-2.5 lg:grid-cols-2 lg:items-stretch">
              {navigationSection ? renderConfigSection(navigationSection) : <div />}
              {supportSection ? renderConfigSection(supportSection) : <div />}
            </div>
          )}

          {(presetSection || firstExtraSection) && (
            <div className="grid gap-2.5 lg:grid-cols-2 lg:items-stretch">
              {presetSection ? renderConfigSection(presetSection) : <div />}
              {firstExtraSection ? renderConfigSection(firstExtraSection) : <div />}
            </div>
          )}

          {remainingExtraRows.map(([leftSection, rightSection], index) => (
            <div key={`extra-row-${index}`} className="grid gap-2.5 lg:grid-cols-2 lg:items-stretch">
              {leftSection ? renderConfigSection(leftSection) : <div />}
              {rightSection ? renderConfigSection(rightSection) : <div />}
            </div>
          ))}

          <div className="grid gap-2.5 lg:grid-cols-2 lg:items-stretch">
            {rotationSection ? renderConfigSection(rotationSection) : <div />}

            <section
              className="rounded-lg border p-2.5 h-full"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
              }}
            >
              <div className="flex items-start gap-2">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
                  }}
                >
                  <Lock className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    System Standard
                  </h4>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Fixed shortcuts shared across all configurations.
                  </p>
                </div>
              </div>

              <div className="mt-1.5 space-y-1">
                {universalRows.map((row) => (
                  <div
                    key={row.action}
                    className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
                    }}
                    title="System standard shortcut"
                  >
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {row.label}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {row.tokenGroups.map((group, groupIndex) => (
                        <React.Fragment key={`${row.action}-${groupIndex}`}>
                          {group.map((token) => (
                            <KbdToken key={`${row.action}-${groupIndex}-${token}`}>{token}</KbdToken>
                          ))}
                          {groupIndex < row.tokenGroups.length - 1 && (
                            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>or</span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      <div
        className="mt-auto flex items-center justify-end border-t pt-2"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <button
          type="button"
          onClick={resetToDefaults}
          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
          style={{
            color: 'var(--accent-secondary-action-color)',
            borderColor: 'var(--accent-secondary-action-border)',
            background: 'var(--accent-secondary-action-bg-92)',
          }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to Defaults
        </button>
      </div>

      {/* Recording Overlay/Hint */}
      {recordingKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm px-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRecordingKey(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-xl border p-5 shadow-2xl"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="flex items-center gap-1.5">
              <h4 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                Recording Shortcut
              </h4>
            </div>

            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              Press the new key combination now.
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Press <strong>Esc</strong> or click outside to cancel.
            </p>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setRecordingKey(null)}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
              >
                Cancel
              </button>
            </div>
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
  const tokens = getBindingTokens(binding);

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition-colors"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-2), transparent 10%)',
      }}
    >
      <span className="min-w-0 text-[11px] truncate" style={{ color: 'var(--text-strong)' }} title={label}>
        {label}
      </span>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (isRecording) {
            onCancel();
          } else {
            onRecord();
          }
        }}
        className="inline-flex min-w-[108px] items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[10px] transition-all"
        style={isRecording
          ? {
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)',
            color: 'var(--text-strong)',
          }
          : {
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-1)',
            color: 'var(--text-muted)',
          }}
      >
        {isRecording ? (
          <span className="font-medium">Press keys…</span>
        ) : (
          tokens.map((token) => <KbdToken key={`${binding.description}-${token}`}>{token}</KbdToken>)
        )}
      </button>
    </div>
  );
}

function KbdToken({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex min-w-[20px] items-center justify-center rounded border px-1 py-0.5 font-mono text-[10px]"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-2), transparent 4%)',
        color: 'var(--text-strong)',
      }}
    >
      {children}
    </kbd>
  );
}
