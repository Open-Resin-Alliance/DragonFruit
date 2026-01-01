# Island Volumes — Concise Master Plan (Overlap Policy, Invariants, Validation)

This document is the **short checklist** version of the island/volume plan. It focuses on the parts that most commonly make the results “feel wrong”: **overlap policy**, **invariants**, and a **validation suite**.

For deeper background and extended explanations, see:

- `Scratch/Island_Volumes_Flat_Cutoffs_and_Merge_Hierarchy_Summary.md`

---

## 1) Goal (What “correct” looks like)

A correct scan/volume system should produce results that match human intuition:

- **Identity stability:** a tracked region should not suddenly “take over” unrelated mass.
- **Coherent pieces:** any single tracked node should represent one connected blob per layer.
- **Natural hierarchy:** fingers → palm → arm → torso, toes → foot → leg → pelvis, etc.
- **No winner-parent merges:** when multiple things merge, the merged material above the merge must not be assigned to one of the children.

---

## 2) Overlap Policy (The single most important definition)

Everything depends on a clear, consistent answer to:

> When do we consider a component on layer L to be the “same thing” as a component on layer L-1?

### 2.1 Definitions

- **Solid mask:** where material exists on a given layer.
- **Island/unsupported mask:** solid pixels with no “support” directly below.
- **Layer component:** a connected blob on a single layer mask.

### 2.2 Recommended workflow for stability

- Track **components on the solid mask** to get stable topology.
- Separately mark which components (or parts of them) are **born unsupported** to identify true leaf islands.

This prevents fragile results that come from only tracking unsupported pixels.

### 2.3 What counts as overlap

When comparing a component on layer L with layer L-1:

- **Use 8-way connectivity** within a slice (default).
- **Allow a small support buffer** between layers as a tolerance for sampling.

Recommended starting point:

- **Support buffer (tolerance): 3 pixels**
  - Meaning: when checking “is this supported by the layer below?”, allow a small XY neighborhood (up to 3 pixels) to count as support.
  - Purpose: reduce false islands caused by minor rasterization jitter.

### 2.4 Minimum overlap to avoid nonsense merges

A common failure is “1-pixel touch causes a merge.”

To prevent that, define at least one of these rules:

- **Minimum overlap area:** require overlap >= N pixels (often 2–4+) before you treat it as real continuity.
- **Minimum overlap ratio:** overlap must exceed a fraction of the smaller component (useful when components vary a lot).

Pick one and enforce it consistently.

Recommended starting point (simple and effective):

- **Minimum overlap area threshold: 4 pixels** (sensitive)
- **Minimum overlap area threshold: 9 pixels** (more conservative)

Why this is separate from the 3-pixel support buffer:

- The support buffer is a small tolerance for “is there something below me?”
- The minimum overlap threshold prevents accidental “1-pixel touches” from turning into merges/continuations that make volumes feel wrong.

---

## 3) Identity Rules (Continuation vs New Node)

This is the rule set that prevents the takeover problems.

### 3.1 Continuation is ONLY allowed for strict 1-to-1

A node continues from L-1 to L only if:

- The component at L overlaps exactly **one** component at L-1, AND
- That component at L-1 overlaps exactly **one** component at L

If either side maps to multiple components, it is an event.

### 3.2 Events always create new node(s)

- **Birth:** new component with no valid overlap below → start a new node.
- **Merge (many-to-one):** end all incoming nodes at L-1 → start a new parent node at L.
- **Split (one-to-many):** end the incoming node at L-1 → start new nodes at L.
- **Death:** a node has no valid overlap above → end it.

Key outcome:

- No node ID ever “passes through” a merge/split.

---

## 4) Invariants (Non-negotiable checks)

If any of these are violated, the output is not trustworthy.

### Invariant A — One node cannot be disconnected on the same layer

- A node’s footprint on any single layer must be a single connected blob.

### Invariant B — No continuation through merge/split

- If a node has multiple parents/children at a layer boundary, it must terminate and new node(s) must start.

### Invariant C — Node layer range is contiguous

- No gaps unless you explicitly support “gap bridging.”

### Invariant D — Merge consistency

At a merge layer:

- The new parent’s first-layer footprint should be substantially covered by the union of child footprints from the previous layer (within your support buffer/tolerance).

### Invariant E — Split consistency

At a split layer:

- The old node’s last-layer footprint should be substantially covered by the union of the new children footprints (within tolerance).

---

## 5) Validation Suite (Small set of truth shapes)

The fastest way to build confidence is to keep a tiny set of “truth” models where the expected behavior is obvious.

### 5.1 Required test shapes

1) **Single pillar**
- Expected: one node from bottom to top.

2) **Two pillars merging into one** (clean Y merge)
- Expected: two child nodes terminate at merge layer; a new parent node starts above.

3) **One pillar splitting into two** (clean split)
- Expected: one node terminates at split; two new nodes start.

4) **Finger → palm → arm** (multi-level merges)
- Expected: stable multi-step hierarchy, no takeover.

5) **Tiny nub merging into big mass** (earlobe case)
- Expected: nub remains a small leaf; big mass remains separate; no leaf takeover.

6) **Diagonal near-touch / 1-pixel bridge case**
- Expected: behavior controlled by your minimum-overlap rule; no random merges.

### 5.2 What to verify visually

Using the slice viewer:

- **Why did this continue?** show overlap stats.
- **Why did this merge?** show which IDs contributed and overlap counts.
- **Does any ID appear in two separate places on one layer?** (should not).

---

## 6) “Logical volumes” (How you build volumes you can reason about)

Once the scan produces stable nodes:

- A practical “logical volume” is typically a **subtree union**.
- Store it as a **stack of 2D masks per layer** (RLE), not cube voxels.

This keeps:

- computation reasonable
- visualization fast
- results explainable

---

## 7) Visualization (Fast ways to see what’s happening)

- **Slice viewer:** the truth source.
- **3D contour stack:** 3D context without cube voxels.
- **Surface overlay:** do per-pixel lookup into the scan label field (avoid per-triangle coloring).

---

## 8) What to implement first (to avoid the 7th wrong version)

1) Lock down overlap policy (buffer + minimum overlap threshold).
2) Enforce strict 1-to-1 continuation.
3) Enforce invariants (fail loudly in debug).
4) Validate against the truth shapes.

If those pass, most real models will “feel right,” and the remaining issues become tuning—not structural mistakes.
