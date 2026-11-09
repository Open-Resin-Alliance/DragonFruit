import { msg } from '@lingui/core/macro';
import {
  Boxes,
  Copy,
  FlipHorizontal2,
  Hand,
  LayoutGrid,
  Move3D,
  PencilRuler,
} from 'lucide-react';
import type { TransformMode } from '@/hooks/useModelTransform';
import { AutoSupportIcon, CutSeamIcon, HollowShellIcon, InteriorViewIcon, IslandPalmIcon, LineSupportIcon, PlaceOnFaceIcon, SmoothingSphereIcon, SolidSupportIcon, type ToolRailEntry } from '@/components/controls/ToolRail';

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
  /**
   * The model list's tile. Only the left column asks for one: the bar under the
   * app bar always shows the list, so the caller there passes no toggle — and
   * these two are given together or not at all.
   */
  modelsPanelVisible?: boolean;
  onToggleModelsPanel?: () => void;
};

/** The eight model tools, preceded by the model list's tile when one is asked for. */
export function buildPrepareToolRailEntries({
  mode,
  onModeChange,
  onModeHover,
  modelsPanelVisible,
  onToggleModelsPanel,
}: PrepareToolRailOptions): ToolRailEntry[] {
  const tools: Array<{ mode: TransformMode; label: ToolRailEntry['label']; hint: ToolRailEntry['hint']; icon: ToolRailEntry['icon']; separated?: ToolRailEntry['separated'] }> = [
    { mode: 'select', label: msg({ message: 'Drag', comment: 'Tool rail label. The tool that drags and places models on the plate. Deliberately "Drag" rather than "Arrange": the app uses "Arrange" elsewhere for arranging the whole plate, and Spanish distinguishes the two.' }), hint: msg`Move and place models on the plate`, icon: Hand },
    { mode: 'transform', label: msg`Transform`, hint: msg`Move, rotate, and scale`, icon: Move3D },
    {
      mode: 'placeOnFace',
      label: msg({ message: 'On-Face', comment: 'Tool rail label. Short for "lay the model flat on a selected face"; keep it terse so the rail entry stays one line.' }),
      hint: msg`Orient flat against plate`,
      icon: PlaceOnFaceIcon,
    },
    { mode: 'mirror', label: msg`Mirror`, hint: msg`Mirror across X, Y, or Z`, icon: FlipHorizontal2 },
    // Three groups: orient the model, lay out copies, then edit its surface.
    { mode: 'duplicate', label: msg`Duplicate`, hint: msg`Array copies across the plate`, icon: Copy, separated: 'above' },
    { mode: 'arrange', label: msg`Arrange`, hint: msg({ message: 'Arrange models on the plate', comment: 'Tool rail entry. The tool that auto-packs the models onto the plate.' }), icon: LayoutGrid },
    { mode: 'organicCut', label: msg({ message: 'Split', comment: 'Tool rail label in Prepare mode. Splits the model along a drawn seam.' }), hint: msg`Split the model along a drawn seam`, icon: CutSeamIcon, separated: 'above' },
    { mode: 'smoothing', label: msg({ message: 'Smooth', comment: 'Tool rail label in Prepare mode. The tool brushes and smooths local surface regions.' }), hint: msg`Sculpt and smooth surface`, icon: SmoothingSphereIcon },
  ];

  // The list's tile is a column affordance — the bar's caller passes no toggle,
  // so no tile is built for it.
  const modelsEntry: ToolRailEntry | null = onToggleModelsPanel === undefined
    ? null
    : {
      id: 'models',
      label: msg`Models`,
      hint: msg({ message: 'Show or hide the model list', comment: 'Tool rail entry that toggles the model list panel on the left. The list is the panel titled "Models".' }),
      icon: Boxes,
      active: modelsPanelVisible === true,
      invertLit: true,
      tone: 'panel',
      separated: 'below',
      onSelect: onToggleModelsPanel,
    };

  return [
    ...(modelsEntry === null ? [] : [modelsEntry]),
    ...tools.map((tool) => ({
      id: tool.mode,
      label: tool.label,
      hint: tool.hint,
      icon: tool.icon,
      active: mode === tool.mode,
      tone: 'tool' as const,
      onSelect: () => onModeChange(tool.mode),
      onHover: (entering: boolean) => onModeHover?.(entering ? tool.mode : null),
      separated: tool.separated,
    })),
  ];
}

export type SupportToolRailOptions = {
  /** The Support panel tool that is showing its panel. */
  mode: SupportRailMode;
  onModeChange: (mode: SupportRailMode) => void;
  /** The model list's tile. See `PrepareToolRailOptions`. */
  modelsPanelVisible?: boolean;
  onToggleModelsPanel?: () => void;
  /**
   * The Hollowing tool is a transform mode, not a Support panel mode: selecting
   * it sets `transformMgr.transformMode` and shows the hollowing workflow. While
   * it is active the panel tools are deselected but their mode is kept, so
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
 * Support mode's entries, top to bottom: the model list, the island scan, the two
 * panel groups, the hollowing pair, then the view toggle. A panel tool *selects* —
 * its panel is the one shown, the others are hidden — and the model list is a panel
 * toggle, because the list is mounted in both modes and only its visibility
 * changes. The list's tile is left out when the caller doesn't offer the toggle.
 *
 * The labels are only ever read in a tile's tooltip, so they name the tool rather
 * than fitting a box, and the comments give each one the context its translation
 * needs.
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
  /**
   * The three panel tools by the mode each selects. Keyed rather than listed, so
   * that the rail's order is only ever the array at the bottom of this function.
   */
  const panelTools: Record<SupportRailMode, { label: ToolRailEntry['label']; hint: ToolRailEntry['hint']; icon: ToolRailEntry['icon'] }> = {
    islands: {
      label: msg({ message: 'Islands', comment: 'Tool rail label in Support mode. Short for the Islands panel, which scans the model for unsupported islands.' }),
      hint: msg({ message: 'Scan the model for unsupported islands', comment: 'Tool rail entry in Support mode. Selecting it shows the Islands panel.' }),
      icon: IslandPalmIcon,
    },
    auto: {
      label: msg({ message: 'Automatic', comment: 'Tool rail label in Support mode. Short for the Auto Supports panel, which generates supports automatically.' }),
      hint: msg({ message: 'Auto support generation', comment: 'Tool rail entry in Support mode. Selecting it shows the Auto Supports panel, which generates supports.' }),
      icon: AutoSupportIcon,
    },
    manual: {
      label: msg({ message: 'Manual', comment: 'Tool rail label in Support mode. Short for the manual support settings panel (tip, shaft, roots, bracing).' }),
      hint: msg({ message: 'Support settings and presets', comment: 'Tool rail entry in Support mode. Selecting it shows the support parameter sidebar (tip, shaft, roots, bracing).' }),
      icon: PencilRuler,
    },
  };

  /** One panel tool as a tile. `separated` is the group gap on its own side. */
  const panelTool = (railMode: SupportRailMode, separated?: ToolRailEntry['separated']): ToolRailEntry => ({
    id: railMode,
    label: panelTools[railMode].label,
    hint: panelTools[railMode].hint,
    icon: panelTools[railMode].icon,
    active: !hollowingActive && mode === railMode,
    tone: 'tool',
    separated,
    onSelect: () => onModeChange(railMode),
  });

  // Same column-only tile as Prepare's.
  const modelsEntry: ToolRailEntry | null = onToggleModelsPanel === undefined
    ? null
    : {
      id: 'models',
      label: msg`Models`,
      hint: msg({ message: 'Show or hide the model list', comment: 'Tool rail entry that toggles the model list panel on the left. The list is the panel titled "Models".' }),
      icon: Boxes,
      active: modelsPanelVisible === true,
      invertLit: true,
      tone: 'panel',
      separated: 'below',
      onSelect: onToggleModelsPanel,
    };

  return [
    ...(modelsEntry === null ? [] : [modelsEntry]),
    panelTool('islands'),
    panelTool('manual', 'above'),
    panelTool('auto'),
    {
      id: 'hollowing',
      label: msg({ message: 'Hollow', comment: 'Tool rail label in Support mode. One word, like the other tool names: opens the hollowing tool (shell the model, add drainage holes).' }),
      hint: msg`Create cavity or open-face shell`,
      icon: HollowShellIcon,
      active: hollowingActive,
      tone: 'tool',
      separated: 'above',
      onSelect: onSelectHollowing,
    },
    {
      id: 'interiorView',
      label: msg({ message: 'Interior View', comment: 'Tool rail label in Support mode. Toggles looking inside a hollowed model instead of at its outside.' }),
      hint: interiorViewAvailable
        ? msg({ message: 'Look inside the hollow, at the cavity and its drain holes', comment: 'Tool rail entry in Support mode, enabled once the model has been hollowed.' })
        : msg({ message: 'Hollow the model first to look inside it', comment: 'Tool rail entry in Support mode, shown greyed when the model has no cavity yet.' }),
      icon: InteriorViewIcon,
      active: interiorView,
      tone: 'tool',
      disabled: !interiorViewAvailable,
      onSelect: onToggleInteriorView,
    },
    {
      id: 'viewMode',
      label: msg({ message: 'View Mode', comment: 'Tool rail label in Support mode. Toggles the support display between everything drawn solid and contact discs with line members.' }),
      hint: msg({ message: 'How the support forest is drawn', comment: 'Tool rail entry in Support mode. A toggle: lit means the line view, unlit the solid one.' }),
      // The tile wears the icon of the mode in use as well as the lit state, so the
      // rail answers "how am I looking at this?" at a glance.
      icon: viewMode === 'lines' ? LineSupportIcon : SolidSupportIcon,
      active: viewMode === 'lines',
      tone: 'tool',
      separated: 'above',
      onSelect: () => onViewModeChange(viewMode === 'lines' ? 'full' : 'lines'),
    },
  ];
}
