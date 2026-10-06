export { Button } from './Button';
export { IconButton } from './IconButton';
export { IconChip } from './IconChip';
export { ICON_TONE_STYLES, type IconTone } from './iconTone';
export { Input } from './Input';
export { Select } from './Select';
export { Card, CardHeader } from './Card';
export { Toast, ToastViewport } from './Toast';
export { cn } from './cn';
export { ColorSwatchInput } from './ColorSwatchInput';
export { AlertDiamondIcon } from './AlertDiamondIcon';
export { ProgressBar } from './ProgressBar';
export { Spinner } from './Spinner';
export { Toggle } from './Toggle';
export { SegmentedControl, type SegmentedOption } from './SegmentedControl';
export { SettingRow } from './SettingRow';
export { BlockingOverlay } from './BlockingOverlay';
// `PanelCollapseToggle` is deliberately NOT re-exported here. It resolves its
// accessible name through the Lingui catalog, so it imports `@lingui/core/macro`,
// and that module throws by design when it runs untransformed. The barrel is the
// one atom module graph that unit tests import (`node --test` cannot run the SWC
// macro transform), so a macro reachable from here breaks unrelated tests.
// Import it directly: `import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';`
// `src/components/atoms/__tests__/barrel.test.ts` guards this.
