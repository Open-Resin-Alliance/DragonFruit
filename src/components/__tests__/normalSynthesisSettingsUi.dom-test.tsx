import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import React, { act, useState } from 'react';

import { AutoSupportSettingsBody } from '@/components/controls/autoSupport/AutoSupportSettingsBody';
import { createDefaultAutoSupportSettings, type AutoSupportSettings } from '@/supports/autoSupport/settings';
import { ANCHOR_PRESET, DETAIL_PRESET } from '@/supports/Settings/presets';
import { DEFAULT_SIDEBAR_PANEL, setActiveSidebarPanel } from '@/supports/Settings/sidebarPanels';
import {
    getSettings,
    setSettings,
    updateDevToolsEnabled,
    updateNormalSynthesisPreset,
    updateSmoothContactNormals,
} from '@/supports/Settings/state';
import { SupportSidebar } from '@/supports/Settings/SupportSidebar';
import { createDefaultSettings } from '@/supports/Settings/types';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

function AutoSupportHarness({
    initial,
    presetLocked = false,
    onDraftChange,
}: {
    initial?: AutoSupportSettings;
    presetLocked?: boolean;
    onDraftChange: (draft: AutoSupportSettings) => void;
}) {
    const [draft, setDraft] = useState<AutoSupportSettings>(() => initial ?? createDefaultAutoSupportSettings());

    const handleSetDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>> = (updater) => {
        setDraft((prev) => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            onDraftChange(next);
            return next;
        });
    };

    return (
        <AutoSupportSettingsBody
            draft={draft}
            setDraft={handleSetDraft}
            debugSimpleRender={false}
            onToggleDebugSimpleRender={() => {}}
            diagnostics={{ debugSupportOriginColors: false, debugSkipAutoBracing: false }}
            onToggleDiagnostic={() => {}}
            debugMode={false}
            onToggleDebugMode={() => {}}
            presetLocked={presetLocked}
        />
    );
}

function findDistributionToggleSwitch(container: HTMLElement): HTMLButtonElement {
    const buttons = [...container.querySelectorAll('button[role="switch"]')] as HTMLButtonElement[];
    const match = buttons.find((btn) => btn.closest('label')?.textContent?.includes('Smooth Contact Normals'));
    assert.ok(match, 'Smooth Contact Normals switch must render');
    return match;
}

function findAutoPresetTrigger(container: HTMLElement): HTMLButtonElement {
    const trigger = container.querySelector('button[aria-label="Normal Preset"]') as HTMLButtonElement | null;
    assert.ok(trigger, 'Normal Preset dropdown trigger must render');
    return trigger;
}

async function selectDropdownOption(trigger: HTMLButtonElement, optionLabel: string): Promise<void> {
    await act(async () => {
        trigger.click();
    });
    const listbox = document.body.querySelector('[role="listbox"]');
    assert.ok(listbox, 'dropdown listbox portal must open');
    const options = [...listbox.querySelectorAll('button[role="option"]')] as HTMLButtonElement[];
    const target = options.find((opt) => opt.textContent?.includes(optionLabel));
    assert.ok(target, `option "${optionLabel}" must exist in dropdown`);
    await act(async () => {
        target.click();
    });
}

function findSidebarCheckbox(container: HTMLElement): HTMLInputElement {
    const inputs = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const match = inputs.find((input) => input.closest('label')?.textContent?.includes('Smooth Contact Normals'));
    assert.ok(match, 'SupportSidebar Smooth Contact Normals checkbox must render');
    return match;
}

function findSidebarPresetTrigger(container: HTMLElement): HTMLButtonElement {
    const trigger = container.querySelector('button[aria-label="Normal Synthesis Preset"]') as HTMLButtonElement | null;
    assert.ok(trigger, 'SupportSidebar Normal Synthesis Preset dropdown trigger must render');
    return trigger;
}

function findLabelNumberInput(container: HTMLElement, labelText: string): HTMLInputElement | null {
    const labels = [...container.querySelectorAll('label, div')];
    for (const el of labels) {
        const directLabel = el.querySelector(':scope > span, :scope > div');
        if (directLabel?.textContent?.trim() === labelText) {
            const input = el.querySelector('input');
            if (input instanceof HTMLInputElement) return input;
        }
    }
    return null;
}

beforeEach(() => {
    localStorage.clear();
    setSettings(createDefaultSettings());
    setActiveSidebarPanel(DEFAULT_SIDEBAR_PANEL);
});

afterEach(() => {
    localStorage.clear();
    setSettings(createDefaultSettings());
    setActiveSidebarPanel(DEFAULT_SIDEBAR_PANEL);
});

test('AutoSupportSettingsBody updates smoothContactNormals toggle, 3-mode preset dropdown, and disables dropdown when toggle OFF', async () => {
    let latestDraft = createDefaultAutoSupportSettings();
    const tree = await renderWithProviders(
        <AutoSupportHarness
            onDraftChange={(next) => {
                latestDraft = next;
            }}
        />,
    );

    try {
        const toggle = findDistributionToggleSwitch(tree.container);
        const trigger = findAutoPresetTrigger(tree.container);

        assert.equal(toggle.getAttribute('aria-checked'), 'true');
        assert.equal(trigger.disabled, false);
        assert.ok(trigger.textContent?.includes('Bisector (125°)'));

        await selectDropdownOption(trigger, 'Crease-Lock (55°)');
        assert.equal(latestDraft.normalSynthesisPreset, 'crease-lock');
        assert.ok(trigger.textContent?.includes('Crease-Lock (55°)'));

        await selectDropdownOption(trigger, 'Macro-Smooth');
        assert.equal(latestDraft.normalSynthesisPreset, 'macro-smooth');
        assert.ok(trigger.textContent?.includes('Macro-Smooth'));

        await act(async () => {
            toggle.click();
        });
        assert.equal(latestDraft.smoothContactNormals, false);
        assert.equal(toggle.getAttribute('aria-checked'), 'false');
        assert.equal(trigger.disabled, true, 'dropdown must disable when Smooth Contact Normals is OFF');

        await act(async () => {
            toggle.click();
        });
        assert.equal(latestDraft.smoothContactNormals, true);
        assert.equal(trigger.disabled, false, 'dropdown re-enables when Smooth Contact Normals turns ON');
    } finally {
        await tree.unmount();
    }
});

test('AutoSupportSettingsBody locks Normal Preset dropdown when presetLocked is true', async () => {
    const tree = await renderWithProviders(
        <AutoSupportHarness
            presetLocked
            onDraftChange={() => {}}
        />,
    );

    try {
        const toggle = findDistributionToggleSwitch(tree.container);
        const trigger = findAutoPresetTrigger(tree.container);
        assert.equal(toggle.disabled, true);
        assert.equal(trigger.disabled, true);
    } finally {
        await tree.unmount();
    }
});

test('SupportSidebar Standard Tip layout renders toggle + 3-mode dropdown, disables when OFF, preserves across preset selection, and gates DevTools fields', async () => {
    const tree = await renderWithProviders(<SupportSidebar />);

    try {
        const checkbox = findSidebarCheckbox(tree.container);
        const trigger = findSidebarPresetTrigger(tree.container);

        assert.equal(checkbox.checked, true);
        assert.equal(trigger.disabled, false);
        assert.ok(trigger.textContent?.includes('Bisector (125°)'));
        assert.equal(findLabelNumberInput(tree.container, 'Radius Scale'), null, 'DevTools fields hidden by default');

        await selectDropdownOption(trigger, 'Crease-Lock (55°)');
        assert.equal(getSettings().normalSynthesisPreset, 'crease-lock');
        assert.ok(trigger.textContent?.includes('Crease-Lock (55°)'));

        await selectDropdownOption(trigger, 'Macro-Smooth');
        assert.equal(getSettings().normalSynthesisPreset, 'macro-smooth');

        await act(async () => {
            checkbox.click();
        });
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(checkbox.checked, false);
        assert.equal(trigger.disabled, true, 'Standard Tip dropdown disables when checkbox is OFF');

        // Selecting a built-in trunk preset in SupportSidebar preserves smoothContactNormals & normalSynthesisPreset
        const presetButtons = [...tree.container.querySelectorAll('[data-preset-cell] button')] as HTMLButtonElement[];
        const anchorBtn = presetButtons.find((b) => b.textContent?.includes(ANCHOR_PRESET.name));
        const detailBtn = presetButtons.find((b) => b.textContent?.includes(DETAIL_PRESET.name));
        assert.ok(anchorBtn && detailBtn, 'built-in preset buttons must render');

        await act(async () => {
            anchorBtn.click();
        });
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(getSettings().normalSynthesisPreset, 'macro-smooth');

        await act(async () => {
            detailBtn.click();
        });
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(getSettings().normalSynthesisPreset, 'macro-smooth');

        // DevTools synthesis fields render when devToolsEnabled is true
        await act(async () => {
            updateDevToolsEnabled(true);
        });
        const radiusInput = findLabelNumberInput(tree.container, 'Radius Scale');
        const flatInput = findLabelNumberInput(tree.container, 'Flat Deg');
        const creaseInput = findLabelNumberInput(tree.container, 'Crease Deg');
        const deadbandInput = findLabelNumberInput(tree.container, 'Deadband');
        const slackInput = findLabelNumberInput(tree.container, 'Rim Slack');
        assert.ok(radiusInput && flatInput && creaseInput && deadbandInput && slackInput, 'all 5 DevTools synthesis fields render when enabled');

        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => {
            setInputValue.call(radiusInput, '1.5');
            radiusInput.dispatchEvent(new Event('input', { bubbles: true }));
            radiusInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        });
        assert.equal(getSettings().devTools.normalSampleRadiusScale, 1.5);

        await act(async () => {
            updateDevToolsEnabled(false);
        });
        assert.equal(findLabelNumberInput(tree.container, 'Radius Scale'), null);
    } finally {
        await tree.unmount();
    }
});

test('SupportSidebar Compact Trunk layout renders toggle + 3-mode dropdown and updates settings', async () => {
    const tree = await renderWithProviders(<SupportSidebar />);

    try {
        const scrollViewport = tree.container.querySelector('div.flex-1.min-h-0.overflow-y-auto') as HTMLDivElement | null;
        assert.ok(scrollViewport, 'scroll viewport must exist');
        const scrollContent = scrollViewport.firstElementChild as HTMLDivElement | null;
        assert.ok(scrollContent, 'scroll content must exist');

        Object.defineProperty(scrollViewport, 'clientHeight', { value: 180, configurable: true });
        scrollContent.getBoundingClientRect = () => ({
            width: 260,
            height: 620,
            top: 0,
            left: 0,
            right: 260,
            bottom: 620,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;

        await act(async () => {
            window.dispatchEvent(new Event('resize'));
        });
        await settle(50);

        // Verify compact trunk layout became active (two-column paired geometry grid)
        assert.ok(
            tree.container.querySelector('.grid.grid-cols-2.gap-1\\.5.items-start'),
            'Compact Trunk layout must mount when viewport overflows',
        );

        const checkbox = findSidebarCheckbox(tree.container);
        const trigger = findSidebarPresetTrigger(tree.container);
        assert.equal(checkbox.checked, true);
        assert.equal(trigger.disabled, false);

        await selectDropdownOption(trigger, 'Crease-Lock (55°)');
        assert.equal(getSettings().normalSynthesisPreset, 'crease-lock');

        await act(async () => {
            checkbox.click();
        });
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(trigger.disabled, true);

        await act(async () => {
            updateSmoothContactNormals(true);
            updateNormalSynthesisPreset('bisector');
        });
        assert.equal(findSidebarCheckbox(tree.container).checked, true);
        assert.equal(findSidebarPresetTrigger(tree.container).disabled, false);
    } finally {
        await tree.unmount();
    }
});
