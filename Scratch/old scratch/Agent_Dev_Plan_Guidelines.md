# Agent Development Plan Guidelines

This document outlines the required format and structure for all Development Plans created by agents.

## 1. Non-Technical Overview (The "Why" and "What")
**Placement:** Top of the document.
**Content:** 
- A clear, "common language" explanation of the goals.
- A non-technical walkthrough of the proposed workflow.
- **Purpose:** To allow the user (and future readers) to quickly grasp the intent without getting bogged down in code details immediately.

## 2. Execution Checklist (The "How" and "When")
**Placement:** Middle of the document.
**Content:**
- A markdown checklist (`- [ ]`) containing discrete, actionable steps.
- **Logical Ordering:** Steps MUST be ordered in a logical development sequence (dependencies first, foundational work before polish). Do NOT simply list items randomly; think through the build process.
- **Agent Instructions:** 
    - *Constraint:* Agents must update this document after completing each phase or checklist item.
    - Mark items as checked (`- [x]`) as they are completed.

## 3. Technical Specifications (The "Details")
**Placement:** End of the document.
**Content:**
- **Relevant Context:** Directory structures, file paths, and existing function names relevant to the task.
- **New Logic:** Proposed function signatures, data structures, or algorithms.
- **Integration Points:** How this new feature connects to the existing codebase.
- **Purpose:** tailored reference for the agent during the coding phase.

---

## Example Template

```markdown
# [Feature Name] Development Plan

## Overview
[Plain English explanation of what we are building and why. Describe the user experience or the high-level logic flow.]

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 1: Foundation**
    - [ ] Setup directory structure
    - [ ] Create basic definitions/types
- [ ] **Phase 2: Core Logic**
    - [ ] Implement algorithm X
    - [ ] Connect signal Y
- [ ] **Phase 3: UI & Polish**
    - [ ] Add visualization components

## Technical Details
### Relevant Files
- `src/path/to/existing/file.ts`

### Proposed Structure
- `src/path/to/new/feature/`
    - `index.ts`
    - `types.ts`

### Functions
- `calculateSomething(input: number): void`
```
