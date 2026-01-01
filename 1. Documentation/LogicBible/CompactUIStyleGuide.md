# UI Style Guide: "Compact Panel" System

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

**Sub-Container (Grouped Controls):**
```tsx
<div className="bg-neutral-750 rounded p-1">
```
*Note: `bg-neutral-750` is a custom utility or `bg-[#2b2b2b]`*

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
className="text-xs text-neutral-200"
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

// Inactive (Off)
<button className="px-1.5 py-0.5 text-[10px] rounded transition-colors bg-neutral-600 text-white">
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
| Element | Tailwind Class | Usage |
| :--- | :--- | :--- |
| **Panel Bg** | `bg-neutral-800/95` | Main card background |
| **Input Bg** | `bg-neutral-700` | Input fields, secondary buttons |
| **Border** | `border-neutral-600` | Input borders |
| **Separator** | `border-neutral-700` | Section dividers |
| **X Axis** | `text-red-400` | X Labels/Focus |
| **Y Axis** | `text-green-400` | Y Labels/Focus |
| **Z Axis** | `text-blue-400` | Z Labels/Focus |
