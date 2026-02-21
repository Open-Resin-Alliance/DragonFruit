import React from 'react';
import { Select } from '@/components/ui/primitives';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ThemePreset = 'dragonfruit-dark';

export type ThemeColors = {
	surface0: string;
	accent: string;
	primaryButtonSurface: string;
	accentContrast: string;
	accentSecondary: string;
	secondaryButtonSurface: string;
	accentSecondaryContrast: string;
	sceneGradientRadial: string;
	sceneGradientLinearStart: string;
	sceneGradientLinearMid: string;
	topbarAccent: string;
	surface1: string;
	surface2: string;
	textStrong: string;
	textMuted: string;
	indicator: string;
	borderSubtle: string;
	borderStrong: string;
	danger: string;
};

interface UISettingsTabProps {
	themePreset: ThemePreset;
	onThemePresetChange: (preset: ThemePreset) => void;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	themeColors: ThemeColors;
	onThemeColorChange: (key: keyof ThemeColors, value: string) => void;
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
	const colorRows: Array<{ key: keyof ThemeColors; label: string; placeholder: string }> = [
		{ key: 'surface0', label: 'Surface 0', placeholder: '#111216' },
		{ key: 'accent', label: 'Accent', placeholder: '#ec2a77' },
		{ key: 'primaryButtonSurface', label: 'Primary button surface', placeholder: '#c11f61' },
		{ key: 'accentContrast', label: 'Accent contrast', placeholder: '#fff6ff' },
		{ key: 'accentSecondary', label: 'Accent secondary', placeholder: '#baf72e' },
		{ key: 'secondaryButtonSurface', label: 'Secondary button surface', placeholder: '#9bcc26' },
		{ key: 'accentSecondaryContrast', label: 'Accent secondary contrast', placeholder: '#182106' },
		{ key: 'sceneGradientRadial', label: '3D radial glow', placeholder: '#ff37aa' },
		{ key: 'sceneGradientLinearStart', label: '3D gradient top', placeholder: '#ff37aa' },
		{ key: 'sceneGradientLinearMid', label: '3D gradient mid', placeholder: '#6f33ff' },
		{ key: 'topbarAccent', label: 'Top bar accent', placeholder: '#ec2a77' },
		{ key: 'surface1', label: 'Surface 1', placeholder: '#1a1b21' },
		{ key: 'surface2', label: 'Surface 2', placeholder: '#23252e' },
		{ key: 'textStrong', label: 'Text strong', placeholder: '#f8f8fb' },
		{ key: 'textMuted', label: 'Text muted', placeholder: '#c3c7cf' },
		{ key: 'indicator', label: 'Indicator', placeholder: '#c3c7cf' },
		{ key: 'borderSubtle', label: 'Border subtle', placeholder: '#272a33' },
		{ key: 'borderStrong', label: 'Border strong', placeholder: '#353944' },
		{ key: 'danger', label: 'Danger', placeholder: '#e45454' },
	];

	return (
		<div className="space-y-3">
			<section
				className="rounded-lg border p-3"
				style={{
					background: 'var(--surface-1)',
					borderColor: 'var(--border-subtle)',
				}}
			>
				<h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-strong)' }}>
					Theme
				</h3>
				<p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
					Choose how Dragonfruit appears across the app.
				</p>

				<div className="grid grid-cols-[120px_1fr] items-center gap-2">
					<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
						Theme preset
					</label>
					<Select
						value={themePreset}
						onChange={(e) => onThemePresetChange(e.target.value as ThemePreset)}
					>
						<option value="dragonfruit-dark">Default Dragonfruit Dark</option>
					</Select>
				</div>

				<div className="grid grid-cols-[120px_1fr] items-center gap-2 mt-2">
					<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
						Color scheme
					</label>
					<Select
						value={themePreference}
						onChange={(e) => onThemePreferenceChange(e.target.value as ThemePreference)}
					>
						<option value="system">System</option>
						<option value="dark">Dark</option>
						<option value="light">Light</option>
					</Select>
				</div>

				{colorRows.map((row) => (
					<div key={row.key} className="grid grid-cols-[120px_1fr] items-center gap-2 mt-2">
						<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
							{row.label}
						</label>
						<div className="flex items-center gap-2">
							<input
								type="color"
								value={themeColors[row.key]}
								onChange={(e) => onThemeColorChange(row.key, e.target.value)}
								className="h-8 w-10 rounded border"
								style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
							/>
							<input
								type="text"
								value={themeColors[row.key]}
								onChange={(e) => onThemeColorChange(row.key, e.target.value)}
								className="ui-input flex-1 h-8"
								placeholder={row.placeholder}
							/>
						</div>
					</div>
				))}

				<div className="mt-3 flex items-center justify-between rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
					<div className="text-xs" style={{ color: 'var(--text-muted)' }}>
						Reset all theme colors to defaults.
					</div>
					<button
						type="button"
						onClick={onResetThemeColors}
						className="ui-button ui-button-secondary !px-2.5 !py-1.5 text-xs"
					>
						Reset Theme
					</button>
				</div>
			</section>
		</div>
	);
}
