import React from 'react';
import { Palette } from 'lucide-react';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { Select } from '@/components/ui/primitives';
import type { ThemeCustomColors, ThemePreference, ThemePreset, ThemeProfile } from '@/components/settings/themeCustomizations';

type ThemeColorField = {
	key: keyof ThemeCustomColors;
	label: string;
	description: string;
	placeholder: string;
};

type ThemeColorSection = {
	id: string;
	title: string;
	description: string;
	rows: ThemeColorField[];
};

const THEME_COLOR_SECTIONS: ThemeColorSection[] = [
	{
		id: 'foundation',
		title: 'Foundation surfaces',
		description: 'Core app backgrounds and panel surfaces.',
		rows: [
			{ key: 'background', label: 'App background', description: 'Outer app frame and page background.', placeholder: '#0b0f14' },
			{ key: 'foreground', label: 'App foreground', description: 'Top-level body text fallback color.', placeholder: '#e6ebf2' },
			{ key: 'surface0', label: 'Surface 0', description: 'Main modal and panel base surface.', placeholder: '#111216' },
			{ key: 'surface1', label: 'Surface 1', description: 'Raised cards, tool panes, and section fills.', placeholder: '#1a1b21' },
			{ key: 'surface2', label: 'Surface 2', description: 'Secondary tiles and inset controls.', placeholder: '#23252e' },
		],
	},
	{
		id: 'content',
		title: 'Content contrast',
		description: 'Typography, borders, and neutral UI signals.',
		rows: [
			{ key: 'textStrong', label: 'Text strong', description: 'Primary headings and high-contrast labels.', placeholder: '#f8f8fb' },
			{ key: 'textMuted', label: 'Text muted', description: 'Supporting labels, hints, and metadata.', placeholder: '#c3c7cf' },
			{ key: 'indicator', label: 'Indicator', description: 'Neutral dots, markers, and status indicators.', placeholder: '#c3c7cf' },
			{ key: 'borderSubtle', label: 'Border subtle', description: 'Low-contrast panel and input outlines.', placeholder: '#272a33' },
			{ key: 'borderStrong', label: 'Border strong', description: 'Higher-contrast structural dividers.', placeholder: '#353944' },
		],
	},
	{
		id: 'brand-primary',
		title: 'Primary brand accent',
		description: 'Primary action styling, highlights, and key brand colors.',
		rows: [
			{ key: 'accent', label: 'Accent', description: 'Primary highlight, active icons, and focus color.', placeholder: '#ec2a77' },
			{ key: 'accentHover', label: 'Accent hover', description: 'Hover/pressed state for primary accent actions.', placeholder: '#d81d67' },
			{ key: 'primaryButtonSurface', label: 'Primary button surface', description: 'Filled primary buttons and pills.', placeholder: '#c11f61' },
			{ key: 'accentContrast', label: 'Accent contrast', description: 'Text/icons shown on primary accent fills.', placeholder: '#fff6ff' },
			{ key: 'topbarAccent', label: 'Top bar accent', description: 'Glow and accent wash used by the app bar.', placeholder: '#ec2a77' },
		],
	},
	{
		id: 'brand-secondary',
		title: 'Secondary brand accent',
		description: 'Secondary action styling, complementary highlights, and secondary brand colors.',
		rows: [
			{ key: 'accentSecondary', label: 'Accent secondary', description: 'Secondary accent and approved-action color.', placeholder: '#baf72e' },
			{ key: 'accentSecondaryHover', label: 'Secondary hover', description: 'Hover/pressed state for green actions.', placeholder: '#a6df29' },
			{ key: 'secondaryButtonSurface', label: 'Secondary button surface', description: 'Filled secondary buttons and badges.', placeholder: '#9bcc26' },
			{ key: 'accentSecondaryContrast', label: 'Secondary contrast', description: 'Text/icons shown on green fills.', placeholder: '#182106' },
		],
	},
	{
		id: 'scene',
		title: 'Scene accents',
		description: '3D view gradient treatment and scene chrome.',
		rows: [
			{ key: 'sceneGradientRadial', label: '3D radial glow', description: 'Radial color bloom in the scene backdrop.', placeholder: '#ff37aa' },
			{ key: 'sceneGradientLinearStart', label: '3D gradient top', description: 'Top stop of the linear scene gradient.', placeholder: '#ff37aa' },
			{ key: 'sceneGradientLinearMid', label: '3D gradient mid', description: 'Middle stop of the linear scene gradient.', placeholder: '#6f33ff' },
		],
	},
	{
		id: 'status',
		title: 'Semantic status colors',
		description: 'Feedback colors for success and destructive actions.',
		rows: [
			{ key: 'success', label: 'Success', description: 'Success states, confirmations, and healthy signals.', placeholder: '#2eb67d' },
			{ key: 'danger', label: 'Danger', description: 'Destructive actions, warnings, and errors.', placeholder: '#e45454' },
		],
	},
];

interface UISettingsTabProps {
	themeProfiles: ThemeProfile[];
	themePreset: ThemePreset;
	onThemePresetChange: (preset: ThemePreset) => void;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	themeColors: ThemeCustomColors;
	onThemeColorChange: (key: keyof ThemeCustomColors, value: string) => void;
	isBuiltInThemePreset: boolean;
	isCustomThemeDirty: boolean;
	isThemeResetDirty: boolean;
	onCreateCustomThemeFromPreset: () => void;
	onRequestSaveCustomTheme: () => void;
	onRequestRenameCustomTheme: () => void;
	onRequestDeleteCustomTheme: () => void;
	onExportTheme: () => void;
	onImportTheme: (file?: File) => void | Promise<void>;
	onResetThemeColors: () => void;
}

export function UISettingsTab({
	themeProfiles,
	themePreset,
	onThemePresetChange,
	themePreference,
	onThemePreferenceChange,
	themeColors,
	onThemeColorChange,
	isBuiltInThemePreset,
	isCustomThemeDirty,
	isThemeResetDirty,
	onCreateCustomThemeFromPreset,
	onRequestSaveCustomTheme,
	onRequestRenameCustomTheme,
	onRequestDeleteCustomTheme,
	onExportTheme,
	onImportTheme,
	onResetThemeColors,
}: UISettingsTabProps) {
	const importInputRef = React.useRef<HTMLInputElement | null>(null);
	const [pendingPickerColors, setPendingPickerColors] = React.useState<Partial<Record<keyof ThemeCustomColors, string>>>({});

	const builtInProfiles = themeProfiles.filter((profile) => profile.isBuiltIn);
	const customProfiles = themeProfiles.filter((profile) => !profile.isBuiltIn);
	const accentSecondaryActionStyle92: React.CSSProperties = {
		color: 'var(--accent-secondary-action-color)',
		borderColor: 'var(--accent-secondary-action-border)',
		background: 'var(--accent-secondary-action-bg-92)',
	};
	const dangerActionStyle92: React.CSSProperties = {
		color: 'var(--danger)',
		borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 40%)',
		background: 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
	};
	const mutedActionStyle92: React.CSSProperties = {
		color: 'var(--text-muted)',
		borderColor: 'var(--border-subtle)',
		background: 'var(--surface-1)',
	};

	const themePresetOptions = [
		...builtInProfiles.map((profile) => ({
			value: profile.id as ThemePreset,
			label: profile.name,
			rightContent: 'Built-in',
		})),
		...customProfiles.map((profile) => ({
			value: profile.id as ThemePreset,
			label: profile.name,
			rightContent: 'Custom',
		})),
	];

	const handleImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file) return;
		void onImportTheme(file);
	};

	const handleImportTheme = React.useCallback(() => {
		if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
			void onImportTheme();
			return;
		}
		importInputRef.current?.click();
	}, [onImportTheme]);

	const clearPendingThemeColorPicker = React.useCallback((key: keyof ThemeCustomColors) => {
		setPendingPickerColors((prev) => {
			if (!(key in prev)) return prev;
			const next = { ...prev };
			delete next[key];
			return next;
		});
	}, []);

	const handleThemeColorPickerDraftChange = React.useCallback((key: keyof ThemeCustomColors, value: string) => {
		setPendingPickerColors((prev) => ({
			...prev,
			[key]: value,
		}));
	}, []);

	const commitThemeColorPickerChange = React.useCallback((key: keyof ThemeCustomColors) => {
		const pendingValue = pendingPickerColors[key];
		if (!pendingValue) return;

		if (pendingValue !== themeColors[key]) {
			onThemeColorChange(key, pendingValue);
		}

		clearPendingThemeColorPicker(key);
	}, [clearPendingThemeColorPicker, onThemeColorChange, pendingPickerColors, themeColors]);

	const getDisplayThemeColor = React.useCallback((key: keyof ThemeCustomColors) => {
		return pendingPickerColors[key] ?? themeColors[key];
	}, [pendingPickerColors, themeColors]);

	const renderColorField = (row: ThemeColorField) => (
		<div
			key={row.key}
			className="rounded-md border px-2 py-1.5"
			style={{
				borderColor: 'var(--border-subtle)',
				background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
			}}
			title={row.description}
		>
			<div className="grid grid-cols-[minmax(0,1fr)_10.75rem] items-center gap-2.5">
				<div className="min-w-0">
					<label className="block truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>
						{row.label}
					</label>
				</div>
				<div className="flex min-w-0 items-center gap-1.5">
					<input
						type="color"
						value={getDisplayThemeColor(row.key)}
						onChange={(event) => handleThemeColorPickerDraftChange(row.key, event.target.value)}
						onBlur={() => commitThemeColorPickerChange(row.key)}
						className="h-7 w-8 shrink-0 rounded border"
						style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
					/>
					<input
						type="text"
						value={getDisplayThemeColor(row.key)}
						onChange={(event) => {
							clearPendingThemeColorPicker(row.key);
							onThemeColorChange(row.key, event.target.value);
						}}
						className="ui-input h-7 min-w-0 flex-1 text-[11px]"
						placeholder={row.placeholder}
					/>
				</div>
			</div>
		</div>
	);

	return (
		<div className="space-y-2.5">
			<section
				className="rounded-xl border p-2.5"
				style={{
					background: 'var(--surface-1)',
					borderColor: 'var(--border-subtle)',
				}}
			>
				<div className="mb-2 flex items-start gap-2">
					<span
						className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
						style={{
							borderColor: 'var(--border-subtle)',
							background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
						}}
					>
						<Palette className="h-4 w-4" style={{ color: 'var(--accent)' }} />
					</span>
					<div className="flex-1">
						<h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
							Theme
						</h3>
						<p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
							Preview is live. <span className="font-semibold">Apply</span> saves it.
						</p>
					</div>
				</div>

				<div className="grid gap-2 md:grid-cols-2">
					<div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
						<label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
							Theme preset
						</label>
						<SelectDropdown<ThemePreset>
							value={themePreset}
							options={themePresetOptions}
							onChange={(nextPreset) => onThemePresetChange(nextPreset)}
							selectClassName="!h-8 text-[11px] !leading-none"
							menuClassName="max-w-[28rem]"
							menuFooterDivider
							menuFooterAction={{
								label: '+ New Theme',
								onClick: onCreateCustomThemeFromPreset,
								tone: 'accent',
							}}
						/>
					</div>

					<div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
						<label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
							Color scheme
						</label>
						<Select
							value={themePreference}
							onChange={(event) => onThemePreferenceChange(event.target.value as ThemePreference)}
						>
							<option value="system">System</option>
							<option value="dark">Dark</option>
							<option value="light">Light</option>
						</Select>
					</div>
				</div>

				<div className="mt-2 rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
					<input
						ref={importInputRef}
						type="file"
						accept=".json,application/json"
						onChange={handleImportInputChange}
						className="hidden"
					/>
					<div className="flex flex-wrap items-center justify-between gap-2">
						{isBuiltInThemePreset ? (
							<>
								<div className="flex flex-wrap items-center gap-1.5">
									<button
										type="button"
										onClick={handleImportTheme}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
									>
										Import
									</button>
								</div>
								<div className="ml-auto flex flex-wrap items-center gap-1.5">
									<button
										type="button"
										onClick={onResetThemeColors}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
										style={isThemeResetDirty ? undefined : mutedActionStyle92}
										disabled={!isThemeResetDirty}
										title={isThemeResetDirty ? 'Reset current theme edits to selected preset values' : 'No theme changes to reset'}
									>
										Reset
									</button>
								</div>
							</>
						) : (
							<>
								<div className="flex flex-wrap items-center gap-1.5">
									<button
										type="button"
										onClick={onRequestSaveCustomTheme}
										className="ui-button !h-8 !px-2.5 !py-0 text-[11px]"
										style={isCustomThemeDirty ? accentSecondaryActionStyle92 : mutedActionStyle92}
										disabled={!isCustomThemeDirty}
										title={isCustomThemeDirty ? 'Save current custom theme changes' : 'No unsaved custom theme changes'}
									>
										Save
									</button>
									<button
										type="button"
										onClick={onRequestRenameCustomTheme}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
									>
										Rename
									</button>
									<button
										type="button"
										onClick={onExportTheme}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
									>
										Export
									</button>
									<button
										type="button"
										onClick={handleImportTheme}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
									>
										Import
									</button>
								</div>
								<div className="ml-auto flex flex-wrap items-center gap-1.5">
									<button
										type="button"
										onClick={onResetThemeColors}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
										style={isThemeResetDirty ? undefined : mutedActionStyle92}
										disabled={!isThemeResetDirty}
										title={isThemeResetDirty ? 'Reset current theme edits to selected preset values' : 'No theme changes to reset'}
									>
										Reset
									</button>
									<button
										type="button"
										onClick={onRequestDeleteCustomTheme}
										className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-[11px]"
										style={dangerActionStyle92}
									>
										Delete
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			</section>

			<div className="grid gap-2.5 xl:grid-cols-2">
				{THEME_COLOR_SECTIONS.map((section) => (
					<section
						key={section.id}
						className="rounded-xl border p-2.5"
						style={{
							borderColor: 'var(--border-subtle)',
							background: 'var(--surface-1)',
						}}
					>
						<div className="mb-2">
							<h4 className="text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }}>
								{section.title}
							</h4>
							<p className="mt-0.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
								{section.description}
							</p>
						</div>
						<div className="space-y-1.5">
							{section.rows.map(renderColorField)}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}
