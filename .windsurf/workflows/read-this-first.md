Read this document first before we continue. C:\Users\tyman\OneDrive\AutoSupport\1. Documentation\1. Project Goals.md

## Prompt: “Follow my domain/feature-based folder structure”

When you make changes in this codebase, you must follow my organization rules:

### Rules

- **Organize by domain/feature (by “what it is”), not by file type (by “what it does”).**
  - Do not create generic buckets like `hooks/`, `utils/`, `components/` at the top of a feature area.
  - Instead, create a feature folder (or use an existing one) and put everything for that feature inside it.

- **Single Source of Truth (SSOT) for adjustable values: no magic numbers.**
  - Any user-adjustable numeric value must define its constraints (min/max/step/default) once (typically in the feature’s settings module) and export them.
  - UI controls (sliders/inputs), persistence (load/save/clamp), and runtime logic must all reference those exported constants/helpers.
  - Do not hardcode the same limits in multiple places.

- **Compartmentalize tightly: one concern per file, grouped under the feature folder.**
  - If we add a new support type (or any new domain feature), it gets its own folder, and inside that folder we keep:
    - Rendering/UI for that feature
    - Interaction/placement logic for that feature
    - Builders/composition logic for that feature
    - Feature-specific helpers/types (only if they truly belong to that feature)

- **Avoid monolithic files.**
  - Do not let one file quietly become the owner of dozens of unrelated helpers or responsibilities.
  - Prefer small, coherent files that are easy to edit safely.
  - The goal is to make it hard for one mistake to break a huge swath of logic.
  - If a file starts owning too many different concerns, split it.

- **Keep feature logic physically close together.**
  - If the logic belongs to supports, keep it inside the supports area.
  - If the logic belongs to a specific support type, keep it close to that support type unless it is truly shared.
  - Do not scatter related feature logic across broad top-level folders just because the files are all “hooks” or all “routes” or all “utils”.
  - Organize by where a future edit would naturally be looked for first.

- **Shared / cross-cutting logic goes in shared domain folders, not inside random feature folders.**
  - If multiple support types will use the same logic, it belongs in an existing shared domain area (example: placement solvers, snapping/interaction, settings, primitives).

- **Preserve the project’s existing “source-of-truth” boundaries.**
  - Keep global definitions and state in the appropriate central files, and keep feature folders focused on feature logic—not global plumbing.

- **Before you implement, inspect existing structure and match it.**
  - If you’re not sure where something belongs, look at the closest existing feature and mirror that pattern.

- **Prefer easy-to-follow edit boundaries.**
  - File structure should make it obvious what to call, where to call it, and where to edit it.
  - A change to one feature should ideally stay local to that feature’s files unless the logic is genuinely shared.
  - Favor structure that reduces the blast radius of mistakes.

### Concrete example (based on your `src/supports` structure)

Your supports system is already organized by need/domain, not “function buckets”:

- `src/supports/SupportPrimitives/`
  - Building-block elements (example: `Joint/`, `Knot/`, `Shaft/`, `Roots/`, `ContactCone/`).
- `src/supports/SupportTypes/`
  - High-level support “things” composed from primitives (example: `Trunk/`, `Branch/`).
- `src/supports/interaction/`
  - Universal interaction logic that multiple features reuse (example: snapping, selection, highlighting).
- `src/supports/PlacementLogic/`
  - Shared solvers/algorithms used across support types.
- `src/supports/Settings/`
  - Settings state, types, defaults, and UI for the supports domain.

So if we create a new support type (example: `Brace`), the correct approach is:

- Add a new folder: `src/supports/SupportTypes/Brace/`
- Put Brace-specific renderer, creation/interaction logic, and builder/composition logic inside that folder
- Only put something in `interaction/` or `PlacementLogic/` if it’s truly shared across multiple support types

This same philosophy applies even when not creating a new support type:

- keep support-related logic in the supports domain
- keep trunk-specific logic near trunk files
- keep branch-specific logic near branch files
- only move logic into a shared area when it is actually shared

## Prompt: “Follow instructions literally (questions vs. code changes)”

When I ask a question, you must:

- Answer the question directly.
- Do not change any code or files.
- Do not “infer” that I wanted an implementation.
- Wait for me to confirm the answer (or explicitly ask you to make a change) before editing anything.

When I give instructions, you must:

- Follow the instructions exactly as written.
- If anything is ambiguous, ask clarifying questions before taking action.
- If you think a different approach would be better, propose it as an option, but do not proceed unless I approve.

## Prompt: “Be candid and optimize for the best software (don’t just agree)”

When I propose an idea or plan, you must:

- Treat my idea as a starting point, not the final answer.
- Disagree when appropriate and explain why (clearly and respectfully).
- Offer better alternatives when you see them, and explain tradeoffs (pros/cons, risk, complexity, performance, maintainability).
- Ask clarifying questions when needed to avoid building the wrong thing.
- Still follow the “questions vs. code changes” rule: do not change code unless I explicitly ask you to (or I approve after you propose options).


Read this file next to fully understand how supports are structured:
- `1_Documentation/AnatomyOfSupports/Anatomy-of-Supports.md`

Afterwards I dont need a synopsis of what you read. Simply say "understood" then wait for further instructions.


