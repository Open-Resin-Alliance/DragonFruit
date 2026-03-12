import React from 'react';
import { SelectionHighlightDropdown } from '@/components/controls/SelectionHighlightDropdown';
import type { SelectionHighlightMode } from '@/components/selection';
import { MeshShaderPreviewCanvas } from '@/components/settings/meshSettings/MeshShaderPreviewCanvas';
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
	selectionColor: string;
	onSelectionColorChange: (color: string) => void;
	hoverColor: string;
	onHoverColorChange: (color: string) => void;
	selectionHighlightMode: SelectionHighlightMode;
	onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
	hoverTintStrength: number;
	onHoverTintStrengthChange: (value: number) => void;
	selectedTintStrength: number;
	onSelectedTintStrengthChange: (value: number) => void;
	themePreset: ThemePreset;
	onThemePresetChange: (preset: ThemePreset) => void;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	themeColors: ThemeColors;
	onThemeColorChange: (key: keyof ThemeColors, value: string) => void;
	onResetThemeColors: () => void;
}

export function UISettingsTab({
	selectionColor,
	onSelectionColorChange,
	hoverColor,
	onHoverColorChange,
	selectionHighlightMode,
	onSelectionHighlightModeChange,
	hoverTintStrength,
	onHoverTintStrengthChange,
	selectedTintStrength,
	onSelectedTintStrengthChange,
	themePreset,
	onThemePresetChange,
	themePreference,
	onThemePreferenceChange,
	themeColors,
	onThemeColorChange,
	onResetThemeColors,
}: UISettingsTabProps) {
	const [isPreviewHovered, setIsPreviewHovered] = React.useState(false);
	const [isPreviewSelected, setIsPreviewSelected] = React.useState(false);

	React.useEffect(() => {
		if (selectionHighlightMode === 'none') {
			setIsPreviewSelected(false);
		}
	}, [selectionHighlightMode]);

	const previewSelectedTintColor = selectionHighlightMode === 'spotlight' ? '#ffffff' : selectionColor;
	const previewSelectedTintStrength = selectionHighlightMode === 'spotlight'
		? Math.max(selectedTintStrength, 0.94)
		: selectedTintStrength;

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
				<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-stretch">
					<div className="min-w-0">
						<h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-strong)' }}>
							Selection
						</h3>
						<p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
							Controls how selected and hovered models are emphasized throughout the app.
						</p>

						<div className="grid grid-cols-[88px_1fr] items-center gap-2">
							<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
								Highlight mode
							</label>
							<div className="flex justify-start">
								<SelectionHighlightDropdown
									value={selectionHighlightMode}
									onChange={onSelectionHighlightModeChange}
									fullWidth={false}
								/>
							</div>
						</div>

						<div className="grid grid-cols-[88px_1fr] items-center gap-2 mt-2">
							<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
								Colors
							</label>
							<div className="grid gap-2 sm:grid-cols-2">
								<div className="space-y-1">
									<div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
										Selection
									</div>
									<div className="flex items-center gap-2">
										<input
											type="color"
											value={selectionColor}
											onChange={(e) => onSelectionColorChange(e.target.value)}
											className="h-8 w-10 shrink-0 rounded border"
											style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
										/>
										<input
											type="text"
											value={selectionColor}
											onChange={(e) => onSelectionColorChange(e.target.value)}
											className="ui-input h-8 w-[7.5rem] min-w-0"
											placeholder="#ec2a77"
										/>
									</div>
								</div>
								<div className="space-y-1">
									<div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
										Hover
									</div>
									<div className="flex items-center gap-2">
										<input
											type="color"
											value={hoverColor}
											onChange={(e) => onHoverColorChange(e.target.value)}
											className="h-8 w-10 shrink-0 rounded border"
											style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
										/>
										<input
											type="text"
											value={hoverColor}
											onChange={(e) => onHoverColorChange(e.target.value)}
											className="ui-input h-8 w-[7.5rem] min-w-0"
											placeholder="#ec2a77"
										/>
									</div>
								</div>
							</div>
						</div>

						<div className="grid grid-cols-[88px_1fr] items-center gap-2 mt-2">
							<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
								Hover tint
							</label>
							<div className="space-y-1">
								<div className="flex justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
									<span>Hover intensity</span>
									<span style={{ color: 'var(--text-strong)' }}>{hoverTintStrength.toFixed(2)}</span>
								</div>
								<input
									type="range"
									min="0"
									max="1"
									step="0.01"
									value={hoverTintStrength}
									onChange={(e) => onHoverTintStrengthChange(parseFloat(e.target.value))}
									className="w-full h-2 rounded-lg appearance-none cursor-pointer"
									style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
								/>
							</div>
						</div>

						<div className="grid grid-cols-[88px_1fr] items-center gap-2 mt-2">
							<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
								Selected tint
							</label>
							<div className="space-y-1">
								<div className="flex justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
									<span>Selection intensity</span>
									<span style={{ color: 'var(--text-strong)' }}>{selectedTintStrength.toFixed(2)}</span>
								</div>
								<input
									type="range"
									min="0"
									max="1"
									step="0.01"
									value={selectedTintStrength}
									onChange={(e) => onSelectedTintStrengthChange(parseFloat(e.target.value))}
									className="w-full h-2 rounded-lg appearance-none cursor-pointer"
									style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
								/>
							</div>
						</div>
					</div>

					<div className="flex min-h-[16rem] lg:min-h-full lg:justify-self-end">
						<div
							className="rounded-lg border p-2 w-full lg:w-[15.5rem] shrink-0"
							style={{
								borderColor: 'var(--border-subtle)',
								background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
							}}
						>
							<div
								className="mb-2 rounded-md px-2 py-1 text-[11px] font-medium text-center"
								style={{
									color: 'var(--text-strong)',
									background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
									border: '1px solid var(--border-subtle)',
								}}
							>
								Click to test selection here
							</div>
							<div
								className="w-full aspect-square max-w-full mx-auto"
							>
								<MeshShaderPreviewCanvas
									shaderType="soft_clay"
									matcapVariant="neutral"
									flatUseVertexColors={true}
									useVertexColors={false}
									toonSteps={5}
									meshColor="#a3a3a3"
									materialRoughness={0.65}
									previewModel="knot"
									ambientIntensity={0.6}
									directionalIntensity={0.8}
									xrayOpacity={0.25}
									heatmapBlend={0}
									heatmapContrast={1}
									hoverTintColor={hoverColor}
									selectedTintColor={previewSelectedTintColor}
									hoverTintStrength={hoverTintStrength}
									selectedTintStrength={previewSelectedTintStrength}
									isSelected={selectionHighlightMode !== 'none' && isPreviewSelected}
									isHovered={isPreviewHovered}
									onHoverChange={setIsPreviewHovered}
									onPress={() => setIsPreviewSelected((prev) => !prev)}
									onCanvasPress={() => setIsPreviewSelected(false)}
								/>
							</div>
						</div>
					</div>
				</div>
			</section>

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
					Choose how DragonFruit appears across the app.
				</p>

				<div className="grid grid-cols-[120px_1fr] items-center gap-2">
					<label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
						Theme preset
					</label>
					<Select
						value={themePreset}
						onChange={(e) => onThemePresetChange(e.target.value as ThemePreset)}
					>
						<option value="dragonfruit-dark">Default DragonFruit Dark</option>
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
