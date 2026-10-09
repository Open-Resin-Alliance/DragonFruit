'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { ArrowLeft, ArrowUp, Bug, ClipboardCopy, Database, HelpCircle, Languages, LayoutGrid, PanelTop, RotateCcw, ZoomIn } from 'lucide-react';
import { Button, SegmentedControl, SettingRow } from '@/components/atoms';
import { LanguageSwitcher } from '@/components/ui/LanguageSwitcher';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { type Locale } from '@/i18n';
import type { ImportDefaultsSettings } from '@/features/scene/importDefaultsPreferences';
import type { RaftBottomMode } from '@/supports/Rafts/Crenelated/RaftTypes';
import {
  FLOATING_LAYOUT_DEBUG_REQUEST_EVENT,
  FLOATING_LAYOUT_STORAGE_KEY,
  type FloatingLayoutDebugRequestDetail,
  type ToolLayout,
} from '@/components/layout/floatingLayoutPreferences';
import {
  UI_SCALE_PRESETS,
  MIN_UI_SCALE,
  MAX_UI_SCALE,
  getSavedUiScale,
  normalizeUiScale,
  saveUiScale,
  type UiScaleValue,
} from '@/components/settings/uiScalePreference';
import {
  getSupportPlacementHelpEnabled,
  setSupportPlacementHelpEnabled,
  subscribeSupportPlacementHelp,
} from '@/components/settings/supportPlacementPreferences';

interface GeneralSettingsTabProps {
  floatingLayoutPersistence: boolean;
  onFloatingLayoutPersistenceChange: (value: boolean) => void;
  toolLayout: ToolLayout;
  onToolLayoutChange: (value: ToolLayout) => void;
  onResetFloatingLayout: () => void;
  importDefaults: ImportDefaultsSettings;
  onImportDefaultsChange: (next: ImportDefaultsSettings) => void;
  language: Locale;
  onLanguageChange: (locale: Locale) => void;
}

export function GeneralSettingsTab({
  floatingLayoutPersistence,
  onFloatingLayoutPersistenceChange,
  toolLayout,
  onToolLayoutChange,
  onResetFloatingLayout,
  importDefaults,
  onImportDefaultsChange,
  language,
  onLanguageChange,
}: GeneralSettingsTabProps) {
  const { _ } = useLingui();
  const [layoutDump, setLayoutDump] = React.useState<string>('');
  const [dumpStatus, setDumpStatus] = React.useState<string | null>(null);
  const rootsLockedByLineRaft = importDefaults.raftBottomMode === 'line';

  const [uiScale, setUiScale] = React.useState<UiScaleValue>(() => getSavedUiScale());
  const [customScaleArmed, setCustomScaleArmed] = React.useState(false);
  const isCustomScale = customScaleArmed || !UI_SCALE_PRESETS.includes(uiScale);
  const [supportHelpEnabled, setSupportHelpEnabled] = React.useState(() => getSupportPlacementHelpEnabled());
  React.useEffect(() => subscribeSupportPlacementHelp(() => setSupportHelpEnabled(getSupportPlacementHelpEnabled())), []);

  const handleUiScaleChange = (rawValue: string) => {
    // Selecting "Custom" arms the numeric input but saves nothing — the current
    // scale stays until the user commits a value in the field.
    if (rawValue === 'custom') {
      setCustomScaleArmed(true);
      return;
    }
    setCustomScaleArmed(false);
    const next = normalizeUiScale(Number(rawValue));
    setUiScale(next);
    saveUiScale(next);
  };

  const handleCustomUiScaleChange = (percent: number) => {
    const next = normalizeUiScale(percent / 100);
    setUiScale(next);
    saveUiScale(next);
  };

  const handleDumpCurrentLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const detail: FloatingLayoutDebugRequestDetail = {
      onResult: (snapshot) => {
        setLayoutDump(JSON.stringify(snapshot, null, 2));
        setDumpStatus('Captured current floating layout from runtime state.');
      },
    };

    window.dispatchEvent(new CustomEvent(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, { detail }));
  }, []);

  const handleDumpSavedLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const raw = window.localStorage.getItem(FLOATING_LAYOUT_STORAGE_KEY);
    if (!raw) {
      setLayoutDump('');
      setDumpStatus('No saved layout JSON found in local storage.');
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      setLayoutDump(JSON.stringify(parsed, null, 2));
      setDumpStatus('Loaded saved floating layout JSON from local storage.');
    } catch {
      setLayoutDump(raw);
      setDumpStatus('Saved layout was not valid JSON; showing raw payload.');
    }
  }, []);

  const handleCopyDump = React.useCallback(async () => {
    if (!layoutDump) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setDumpStatus('Clipboard API unavailable in this environment.');
      return;
    }

    try {
      await navigator.clipboard.writeText(layoutDump);
      setDumpStatus('Copied layout JSON to clipboard.');
    } catch {
      setDumpStatus('Failed to copy layout JSON to clipboard.');
    }
  }, [layoutDump]);

  return (
    <div className="space-y-3">
      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Languages className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Language
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Choose the interface language. Detected from your system on first run; your choice is remembered.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Interface language`)}
          description={_(msg`Applied immediately across the app.`)}
        >
          <LanguageSwitcher value={language} onChange={onLanguageChange} />
        </SettingRow>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <ZoomIn className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              UI Scale
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Adjusts the size of the entire interface. 100% adapts to your screen automatically.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <SettingRow
            label={_(msg`Interface scale`)}
            description={_(msg`Larger percentages magnify the whole UI.`)}
          >
            <SelectDropdown<string>
              value={isCustomScale ? 'custom' : String(uiScale)}
              options={[
                ...UI_SCALE_PRESETS.map((preset) => ({ value: String(preset), label: `${Math.round(preset * 100)}%` })),
                { value: 'custom', label: 'Custom' },
              ]}
              onChange={handleUiScaleChange}
              ariaLabel="Interface scale"
              title="Interface scale"
              className="w-36"
              menuAlign="right"
              leadingDisplay={<ZoomIn className="w-4 h-4" />}
              selectClassName="!text-[13px] !pr-9"
            />
          </SettingRow>
          {isCustomScale && (
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Custom scale
              </div>
              <ScrollableNumberField
                className="w-36"
                value={Math.round(uiScale * 100)}
                min={MIN_UI_SCALE * 100}
                max={MAX_UI_SCALE * 100}
                step={1}
                unit="%"
                ariaLabel="Custom interface scale"
                commitOnBlur
                onChange={handleCustomUiScaleChange}
              />
            </div>
          )}
        </div>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <PanelTop className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Toolbar
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Park the tools in a column on the left edge, or in a bar centred under the app bar.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Toolbar position`)}
          description={_(msg`A left column or a bar centred under the app bar.`)}
        >
          <SelectDropdown<ToolLayout>
            value={toolLayout}
            options={[
              { value: 'horizontal', label: _(msg`Top`) },
              { value: 'vertical', label: _(msg`Left`) },
            ]}
            onChange={(next) => onToolLayoutChange(next)}
            ariaLabel="Toolbar position"
            title="Toolbar position"
            className="w-36"
            menuAlign="right"
            leadingDisplay={toolLayout === 'horizontal'
              ? <ArrowUp className="w-4 h-4" />
              : <ArrowLeft className="w-4 h-4" />}
          />
        </SettingRow>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <LayoutGrid className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Floating Windows
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Keep moved panel positions between sessions, or always start from the default workspace layout.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Remember window positions`)}
          description={_(msg`Persist dragged panel positions in local storage.`)}
        >
          <SegmentedControl
            label={_(msg`Remember window positions`)}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
            ]}
            value={floatingLayoutPersistence ? 'on' : 'off'}
            onChange={(next) => onFloatingLayoutPersistenceChange(next === 'on')}
          />
        </SettingRow>

        <SettingRow
          bordered
          className="mt-2"
          label={_(msg`Reset saved window layout`)}
          description={_(msg`Forget all stored panel positions and return to seeded layout.`)}
        >
          <Button
            variant="secondary"
            size="auto"
            onClick={onResetFloatingLayout}
            className="!h-10 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <RotateCcw className="h-4 w-4 shrink-0" />
            Reset
          </Button>
        </SettingRow>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <HelpCircle className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Support Tooltips
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Show placement tooltips next to the cursor while adding supports.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Show support tooltips`)}
          description={_(msg`Shows "Cannot Place Support" and "Stability Warning" tooltips.`)}
        >
          <SegmentedControl
            label={_(msg`Show support tooltips`)}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
            ]}
            value={supportHelpEnabled ? 'on' : 'off'}
            onChange={(next) => {
              const enabled = next === 'on';
              setSupportPlacementHelpEnabled(enabled);
              setSupportHelpEnabled(enabled);
            }}
          />
        </SettingRow>
      </section>

      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Database className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Import Defaults
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Applied automatically when importing Scene Files.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Default Raft Base`)}
          description={_(msg`Chooses raft bottom mode for imported supports.`)}
        >
          <SelectDropdown<RaftBottomMode>
            value={importDefaults.raftBottomMode}
            options={[
              { value: 'off', label: _(msg`Off`) },
              { value: 'line', label: _(msg`Line`) },
              { value: 'solid', label: _(msg`Solid`) },
            ]}
            onChange={(next) => onImportDefaultsChange({
              ...importDefaults,
              raftBottomMode: next,
              rootsEnabled: next === 'line' ? true : importDefaults.rootsEnabled,
            })}
            ariaLabel="Default Raft Base"
            title="Default Raft Base"
            className="w-36"
            menuAlign="right"
          />
        </SettingRow>

        {importDefaults.raftBottomMode === 'solid' ? (
          <SettingRow
            bordered
            className="mt-2"
            label={_(msg`Default Raft Wall`)}
            description={_(msg`Enable perimeter wall for imported solid rafts.`)}
          >
            <SegmentedControl
              label={_(msg`Default Raft Wall`)}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
              value={importDefaults.raftWallEnabled ? 'on' : 'off'}
              onChange={(next) => onImportDefaultsChange({ ...importDefaults, raftWallEnabled: next === 'on' })}
            />
          </SettingRow>
        ) : null}

        {!rootsLockedByLineRaft ? (
          <SettingRow
            bordered
            className="mt-2"
            label={_(msg`Roots Enabled on Import`)}
            description={_(msg`OFF makes imported root diameter match trunk diameter.`)}
          >
            <SegmentedControl
              label={_(msg`Roots Enabled on Import`)}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
              value={importDefaults.rootsEnabled ? 'on' : 'off'}
              onChange={(next) => onImportDefaultsChange({ ...importDefaults, rootsEnabled: next === 'on' })}
            />
          </SettingRow>
        ) : null}

        <SettingRow
          bordered
          className="mt-2"
          label={_(msg`Auto-Repair`)}
          description={_(msg`Automatically runs native mesh auto-repair for standard mesh imports.`)}
        >
          <SegmentedControl
            label={_(msg`Auto-Repair`)}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
            ]}
            value={importDefaults.autoRepair ? 'on' : 'off'}
            onChange={(next) => onImportDefaultsChange({ ...importDefaults, autoRepair: next === 'on' })}
          />
        </SettingRow>

        <SettingRow
          bordered
          className="mt-2"
          label={_(msg`Auto-Repair Scenes`)}
          description={_(msg`Automatically runs native mesh auto-repair for scene-file imports.`)}
        >
          <SegmentedControl
            label={_(msg`Auto-Repair Scenes`)}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
            ]}
            value={importDefaults.autoRepairScenes ? 'on' : 'off'}
            onChange={(next) => onImportDefaultsChange({ ...importDefaults, autoRepairScenes: next === 'on' })}
          />
        </SettingRow>
      </section>

    </div>
  );
}
