import { msg } from '@lingui/core/macro';
import {
  ArrowDownToLine,
  Boxes,
  Copy,
  FlipHorizontal2,
  Hand,
  LayoutGrid,
  Move3D,
  Radar,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react';
import type { TransformMode } from '@/hooks/useModelTransform';
import { CutSeamIcon, HollowShellIcon, InteriorViewIcon, LineSupportIcon, SmoothingSphereIcon, SolidSupportIcon, type ToolRailEntry } from '@/components/controls/ToolRail';

/**
 * The Support tools the rail can select. One is active at a time, and its panel is
 * the one shown.
 */
export type SupportRailMode = 'auto' | 'manual' | 'islands';

/**
 * The rail's entries for each mode. They live here rather than in the rail
 * because the two modes offer different things — Prepare lists its eight model
 * tools plus the model list, Support lists its three tools plus the model list —
 * while the rail itself only knows how to draw and animate a list of entries.
 */

export type PrepareToolRailOptions = {
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
  onModeHover?: (mode: TransformMode | null) => void;
  modelsPanelVisible: boolean;
  onToggleModelsPanel: () => void;
};

/** The eight model tools, then the model list. */
export function buildPrepareToolRailEntries({
  mode,
  onModeChange,
  onModeHover,
  modelsPanelVisible,
  onToggleModelsPanel,
}: PrepareToolRailOptions): ToolRailEntry[] {
  const tools: Array<{ mode: TransformMode; label: ToolRailEntry['label']; hint: ToolRailEntry['hint']; icon: ToolRailEntry['icon'] }> = [
    { mode: 'select', label: msg({ message: 'Drag', comment: 'Tool rail label. The tool that drags and places models on the plate. Deliberately "Drag" rather than "Arrange": the app uses "Arrange" elsewhere for arranging the whole plate, and Spanish distinguishes the two.' }), hint: msg`Move and place models on the plate`, icon: Hand },
    { mode: 'transform', label: msg`Transform`, hint: msg`Move, rotate, and scale`, icon: Move3D },
    {
      mode: 'placeOnFace',
      label: msg({ message: 'On-Face', comment: 'Tool rail label. Short for "lay the model flat on a selected face"; keep it terse so the rail entry stays one line.' }),
      hint: msg`Orient flat against plate`,
      icon: ArrowDownToLine,
    },
    { mode: 'mirror', label: msg`Mirror`, hint: msg`Mirror across X, Y, or Z`, icon: FlipHorizontal2 },
    { mode: 'duplicate', label: msg`Duplicate`, hint: msg`Array copies across the plate`, icon: Copy },
    { mode: 'arrange', label: msg`Arrange`, hint: msg({ message: 'Arrange models on the plate', comment: 'Tool rail entry. The tool that auto-packs the models onto the plate.' }), icon: LayoutGrid },
    { mode: 'organicCut', label: msg({ message: 'Split', comment: 'Tool rail label in Prepare mode. Splits the model along a drawn seam.' }), hint: msg`Split the model along a drawn seam`, icon: CutSeamIcon },
    { mode: 'smoothing', label: msg({ message: 'Smooth', comment: 'Tool rail label in Prepare mode. The tool brushes and smooths local surface regions.' }), hint: msg`Sculpt and smooth surface`, icon: SmoothingSphereIcon },
  ];

  return [
    {
      id: 'models',
      label: msg`Models`,
      hint: msg({ message: 'Show or hide the model list', comment: 'Tool rail entry that toggles the model list panel on the left. The list is the panel titled "Models".' }),
      icon: Boxes,
      active: modelsPanelVisible,
      tone: 'panel',
      separated: 'below',
      onSelect: onToggleModelsPanel,
    },
    ...tools.map((tool) => ({
      id: tool.mode,
      label: tool.label,
      hint: tool.hint,
      icon: tool.icon,
      active: mode === tool.mode,
      tone: 'tool' as const,
      onSelect: () => onModeChange(tool.mode),
      onHover: (entering: boolean) => onModeHover?.(entering ? tool.mode : null),
    })),
  ];
}

export type SupportToolRailOptions = {
  /** The Support panel tool that is showing its panel. */
  mode: SupportRailMode;
  onModeChange: (mode: SupportRailMode) => void;
  modelsPanelVisible: boolean;
  onToggleModelsPanel: () => void;
  /**
   * The Hollowing tool is a transform mode, not a Support panel mode: selecting
   * it sets `transformMgr.transformMode` and shows the hollowing workflow. While
   * it is active the panel tools above are deselected but their mode is kept, so
   * coming back lands on the panel the user left.
   */
  hollowingActive: boolean;
  onSelectHollowing: () => void;
  /**
   * The support display mode. `lines` is the line view the eye button in the
   * Support Studio header used to toggle: contact discs solid, every member a
   * line. `full` renders everything.
   */
  viewMode: SupportViewMode;
  onViewModeChange: (mode: SupportViewMode) => void;
  /**
   * Interior view looks through the shell of a hollowed model. It is only
   * meaningful once a cavity exists, which is what `interiorViewAvailable`
   * answers — the tile greys out rather than hiding while there is nothing to
   * look inside.
   */
  interiorView: boolean;
  interiorViewAvailable: boolean;
  onToggleInteriorView: () => void;
};

/** How the support forest is drawn. */
export type SupportViewMode = 'full' | 'lines';

/**
 * Support mode's entries: the model list, the Hollowing tool, then the three
 * panel tools. A panel tool *selects* — its panel is the one shown, the others
 * are hidden — and the model list is a panel toggle, because the list is mounted
 * in both modes and only its visibility changes.
 *
 * The labels are deliberately one word each: they share a 68px rail, and the
 * comments give each one the context its translation needs.
 */
export function buildSupportToolRailEntries({
  mode,
  onModeChange,
  modelsPanelVisible,
  onToggleModelsPanel,
  hollowingActive,
  onSelectHollowing,
  viewMode,
  onViewModeChange,
  interiorView,
  interiorViewAvailable,
  onToggleInteriorView,
}: SupportToolRailOptions): ToolRailEntry[] {
  const tools: Array<{ mode: SupportRailMode; label: ToolRailEntry['label']; hint: ToolRailEntry['hint']; icon: ToolRailEntry['icon'] }> = [
    {
      mode: 'islands',
      label: msg({ message: 'Islands', comment: 'Tool rail label in Support mode. Short for the Islands panel, which scans the model for unsupported islands.' }),
      hint: msg({ message: 'Scan the model for unsupported islands', comment: 'Tool rail entry in Support mode. Selecting it shows the Islands panel.' }),
      icon: Radar,
    },
    {
      mode: 'auto',
      label: msg({ message: 'Automatic', comment: 'Tool rail label in Support mode. Short for the Auto Supports panel, which generates supports automatically.' }),
      hint: msg({ message: 'Auto support generation', comment: 'Tool rail entry in Support mode. Selecting it shows the Auto Supports panel, which generates supports.' }),
      icon: Sparkles,
    },
    {
      mode: 'manual',
      label: msg({ message: 'Manual', comment: 'Tool rail label in Support mode. Short for the manual support settings panel (tip, shaft, roots, bracing).' }),
      hint: msg({ message: 'Support settings and presets', comment: 'Tool rail entry in Support mode. Selecting it shows the support parameter sidebar (tip, shaft, roots, bracing).' }),
      icon: SlidersHorizontal,
    },
  ];

  return [
    {
      id: 'models',
      label: msg`Models`,
      hint: msg({ message: 'Show or hide the model list', comment: 'Tool rail entry that toggles the model list panel on the left. The list is the panel titled "Models".' }),
      icon: Boxes,
      active: modelsPanelVisible,
      tone: 'panel',
      separated: 'below',
      onSelect: onToggleModelsPanel,
    },
    {
      id: 'hollowing',
      label: msg({ message: 'Hollow', comment: 'Tool rail label in Support mode. One word, like the other tool names: opens the hollowing tool (shell the model, add drainage holes).' }),
      hint: msg`Create cavity or open-face shell`,
      icon: HollowShellIcon,
      active: hollowingActive,
      tone: 'tool',
      onSelect: onSelectHollowing,
    },
    ...tools.map((tool) => ({
      id: tool.mode,
      label: tool.label,
      hint: tool.hint,
      icon: tool.icon,
      active: !hollowingActive && mode === tool.mode,
      tone: 'tool' as const,
      onSelect: () => onModeChange(tool.mode),
    })),
    {
      id: 'viewMode',
      label: msg({ message: 'Visibility', comment: 'Tool rail label in Support mode. Opens the support display modes: everything drawn solid, or contact discs with line members.' }),
      hint: msg({ message: 'How the support forest is drawn', comment: 'Tool rail entry in Support mode. Opens a menu of view modes rather than toggling on its own.' }),
      // The tile wears the icon of the mode in use, so the rail answers "how am
      // I looking at this?" without opening the list.
      icon: viewMode === 'lines' ? LineSupportIcon : SolidSupportIcon,
      // Primary hue, but never lit: the entry opens a list rather than being
      // switched on, so it sits with the tools in their resting state. The mode
      // in use is the lit tile in the list.
      active: false,
      tone: 'tool',
      separated: 'above',
      menu: [
        {
          id: 'full',
          label: msg({ message: 'Full', comment: 'Support view mode. Every support member is drawn as a solid mesh.' }),
          icon: SolidSupportIcon,
          checked: viewMode === 'full',
          onSelect: () => onViewModeChange('full'),
        },
        {
          id: 'lines',
          label: msg({ message: 'Lines', comment: 'Support view mode. Contact discs stay solid and every other member is drawn as a line, which keeps a dense support forest readable.' }),
          icon: LineSupportIcon,
          checked: viewMode === 'lines',
          onSelect: () => onViewModeChange('lines'),
        },
      ],
    },
    {
      id: 'interiorView',
      label: msg({ message: 'Interior', comment: 'Tool rail label in Support mode. Toggles looking inside a hollowed model instead of at its outside. One word, to fit the rail.' }),
      hint: interiorViewAvailable
        ? msg({ message: 'Look inside the hollow, at the cavity and its drain holes', comment: 'Tool rail entry in Support mode, enabled once the model has been hollowed.' })
        : msg({ message: 'Hollow the model first to look inside it', comment: 'Tool rail entry in Support mode, shown greyed when the model has no cavity yet.' }),
      icon: InteriorViewIcon,
      active: interiorView,
      tone: 'tool',
      disabled: !interiorViewAvailable,
      onSelect: onToggleInteriorView,
    },
  ];
}
