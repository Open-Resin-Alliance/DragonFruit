# 4 UI Style Guide: "Compact Panel" System

This guide defines the standard styling for compact floating panels (like the Transform Controls).
Use these Tailwind classes to maintain consistency across the application.

## 1. Panel Containers

**Floating Card:**

```tsx
<div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl w-64">
```

- **Background:** `bg-neutral-800/95` (High opacity, slight transparency)
- **Backdrop:** `backdrop-blur-sm`
- **Padding:** `px-3` (Side), `pb-2` (Bottom), `pt-1` (Top)
- **Width:** `w-64` (Standard compact width)

**Common variants (used in existing panels):**

- **Scrollable content:** Add a max height and `overflow-y-auto` when content can grow.
- **Positioning:** Some panels are positioned individually (e.g. `absolute ...`), while others are placed inside the floating stack layout.

**Sub-Container (Grouped Controls):**

```tsx
<div className="bg-neutral-750 rounded p-1">
```

_Note: `bg-neutral-750` is used across the current UI for grouped controls. If this color is ever removed from the Tailwind theme, replace it with a fixed value like `bg-[#2b2b2b]`._

---

## 2. Typography

**Section Headers:**

```tsx
<h3 className="text-sm font-semibold text-neutral-200 py-1 hover:text-white transition-colors">
```

**Field Labels:**

```tsx
<label className="text-[9px] text-neutral-400 font-medium mb-0.5 block">
```

- **Size:** `text-[9px]` (Micro label)
- **Color:** `text-neutral-400` (Default), or specific axis colors (`text-red-400`, `text-green-400`, `text-blue-400`)

**Input Text:**

```tsx
className = "text-xs text-neutral-200";
```

---

## 3. Interactive Elements

**Inputs (Number/Text):**

```tsx
<input className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners" />
```

- **Padding:** `px-1.5 py-0.5` (Ultra compact)
- **Size:** `text-xs`
- **Border:** `border-neutral-600`

Notes:

- `no-spinners` is only relevant for native `<input type="number">` controls (see `src/app/globals.css`).
- The app often uses a shared `NumberInput` component that renders as `type="text"`, so spinners are not shown regardless.

**Action Buttons (Standard):**

```tsx
<button className="px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors">
```

- **Padding:** `px-1.5 py-1`
- **Size:** `text-[10px]`

**Toggle Buttons (Switch):**

```tsx
// Active (On)
<button className="px-1.5 py-0.5 text-[10px] rounded transition-colors bg-blue-500 text-white">

// Active (Off)
<button className="px-1.5 py-0.5 text-[10px] rounded transition-colors bg-neutral-600 text-white">

// Inactive
<button className="px-1.5 py-0.5 text-[10px] rounded transition-colors bg-neutral-700 text-neutral-400 hover:bg-neutral-600">
```

---

## 4. Spacing & Layout

**Standard Gaps:**

- **Flex Gap:** `gap-1.5`
- **Grid Gap:** `gap-1.5`

**Margins:**

- **Bottom Margin (Sections/Rows):** `mb-1`
- **Label Bottom Margin:** `mb-0.5`

**Separators:**

```tsx
<div className="border-b border-neutral-700">
```

---

## 5. Colors (Reference)

### Theme-first policy (required)

Compact UI surfaces must use **theme tokens** from `src/app/globals.css` so dark/light themes stay consistent.

- ✅ Prefer semantic classes/tokens: `var(--surface-*)`, `var(--text-*)`, `var(--border-*)`, `var(--accent*)`
- ✅ Use `color-mix(...)` with theme tokens for hover/outline states when needed
- ❌ Avoid hardcoded neutral utility chains (for example `bg-neutral-*`, `text-neutral-*`, `border-neutral-*`) in new panel work
- ❌ Avoid fixed hex values for core panel chrome unless the value is a documented semantic token

### Token map (source of truth)

| Role                 | Token                                    | Notes                              |
| :------------------- | :--------------------------------------- | :--------------------------------- |
| App background       | `var(--background)`                      | Shell/base canvas bg               |
| Primary panel bg     | `var(--surface-0)`                       | Main floating cards                |
| Secondary surface    | `var(--surface-1)`                       | Inputs/buttons/inner groups        |
| Tertiary surface     | `var(--surface-2)`                       | Hover/fill tracks/alternate rows   |
| Primary text         | `var(--text-strong)`                     | Main labels and values             |
| Secondary text       | `var(--text-muted)` / `var(--indicator)` | Metadata and helper text           |
| Subtle border        | `var(--border-subtle)`                   | Default panel/input border         |
| Strong border        | `var(--border-strong)`                   | Higher emphasis separators         |
| Primary action       | `var(--accent)`                          | Main interactive accent            |
| Primary action hover | `var(--accent-hover)`                    | Hover/active for primary action    |
| Accent contrast text | `var(--accent-contrast)`                 | Text/icons on accent backgrounds   |
| Secondary action     | `var(--accent-secondary)`                | Dragonfruit secondary brand action |

### Semantic exceptions

- Axis colors (`X`, `Y`, `Z`) can remain axis-specific for readability.
- Destructive/success states should use semantic tokens (`--danger`, `--success`) or mapped utility classes tied to those meanings.
- If legacy Tailwind neutrals are encountered, migrate to semantic token-backed styling when the file is next touched.

| Element       | Tailwind Class       | Usage                           |
| :------------ | :------------------- | :------------------------------ |
| **Panel Bg**  | `bg-neutral-800/95`  | Main card background            |
| **Input Bg**  | `bg-neutral-700`     | Input fields, secondary buttons |
| **Border**    | `border-neutral-600` | Input borders                   |
| **Separator** | `border-neutral-700` | Section dividers                |
| **X Axis**    | `text-red-400`       | X Labels/Focus                  |
| **Y Axis**    | `text-green-400`     | Y Labels/Focus                  |
| **Z Axis**    | `text-blue-400`      | Z Labels/Focus                  |

---

## 6. Normalized Spacing + Typography Baseline (Current Standard)

For DragonFruit V2 floating windows, prefer these normalized tokens and spacing rhythm:

- Container radius: `rounded-lg`
- Base panel edge padding: `8px` (compact rail variants may go lower)
- Standard inter-row spacing: `4px` to `8px`
- Badge padding: `px-1 py-0.5` (micro chips)
- Default panel body type: `var(--font-size-sm)`
- Section title type: `var(--font-size-md)`

Use shared badge visual tokens whenever possible (same border, background, and font treatment) to avoid visual drift between top/bottom/status chips.

---

## 7. Responsive Window Scaling (Viewport-Based)

### Important Principle

Scaling is based on **browser viewport size** (`window.innerWidth` / `window.innerHeight`), not physical monitor dimensions.

### Current behavior

1. **Floating window width scaling** (in `FloatingPanelStack.tsx`)

- Large viewport: scale `1.0`
- <= `1600w` or `900h`: scale `0.95`
- <= `1366w` or `820h`: scale `0.90`
- <= `1100w` or `700h`: scale `0.82`

2. **Panel density scaling** (in `globals.css`)

- `--ui-window-scale` drives panel font sizes and control paddings.
- Applied to `.ui-panel` typography and `.ui-panel` input/button paddings.

### Implementation notes

- Keep per-panel overrides minimal; rely on global scaling first.
- If a panel needs custom width, justify it in this guide.
- For compact rails, normalize chip spacing and edge padding before introducing exceptions.
