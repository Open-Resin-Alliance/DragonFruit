import React from 'react';
import { Palette } from 'lucide-react';
import { Select } from '@/components/ui/primitives';
import type { ThemeCustomColors, ThemePreference, ThemePreset } from '@/components/settings/themeCustomizations';

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
	themePreset: ThemePreset;
	onThemePresetChange: (preset: ThemePreset) => void;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	themeColors: ThemeCustomColors;
	onThemeColorChange: (key: keyof ThemeCustomColors, value: string) => void;
	onResetThemeColors: () => void;
}

export function UISettingsTab({
	themePreset,
	onThemePresetChange,
	themePreference,
	onThemePreferenceChange,
	themeColors,
	onThemeColorChange,
	onResetThemeColors,
}: UISettingsTabProps) {
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
						value={themeColors[row.key]}
						onChange={(event) => onThemeColorChange(row.key, event.target.value)}
						className="h-7 w-8 shrink-0 rounded border"
						style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
					/>
					<input
						type="text"
						value={themeColors[row.key]}
						onChange={(event) => onThemeColorChange(row.key, event.target.value)}
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
						<Select
							value={themePreset}
							onChange={(event) => onThemePresetChange(event.target.value as ThemePreset)}
						>
							<option value="dragonfruit-dark">Default DragonFruit Dark</option>
							<option value="dragonfruit-light">Default DragonFruit Light</option>
						</Select>
						<p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
							Switches the full palette instantly.
						</p>
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
						<p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
							Controls system/dark/light resolution.
						</p>
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

			<div className="flex items-center justify-between rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
				<div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
					Reset the currently selected preset palette back to its default token values.
				</div>
				<button
					type="button"
					onClick={onResetThemeColors}
					className="ui-button ui-button-secondary !px-2.5 !py-1.5 text-xs"
				>
					Reset Theme
				</button>
			</div>
		</div>
	);
}
