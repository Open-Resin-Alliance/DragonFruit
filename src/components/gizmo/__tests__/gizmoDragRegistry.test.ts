import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginGizmoDrag,
  cancelActiveGizmoDrag,
  isGizmoDragActive,
} from "../gizmoDragRegistry";

describe("gizmoDragRegistry", () => {
  it("reports nothing running until a drag claims the slot", () => {
    assert.equal(isGizmoDragActive(), false);
    assert.equal(cancelActiveGizmoDrag(), false, "nothing to cancel is not a cancel");

    const release = beginGizmoDrag(() => {});
    assert.equal(isGizmoDragActive(), true);
    release();
    assert.equal(isGizmoDragActive(), false);
  });

  it("runs the drag's own cancel, and only once", () => {
    let cancels = 0;
    beginGizmoDrag(() => {
      cancels += 1;
    });

    assert.equal(cancelActiveGizmoDrag(), true);
    assert.equal(cancels, 1);
    // The second Escape has nothing left to call off: the caller must be able to
    // tell that apart and go back to doing whatever Escape normally does.
    assert.equal(cancelActiveGizmoDrag(), false);
    assert.equal(cancels, 1);
  });

  it("lets the cancelled drag release afterwards without disowning a newer one", () => {
    // The cancel path clears the slot itself, and the ring then runs its own
    // release from the same teardown. A release that just nulled the slot would
    // silently drop the drag that started in between.
    let release: (() => void) | null = null;
    release = beginGizmoDrag(() => {});
    cancelActiveGizmoDrag();

    const otherRelease = beginGizmoDrag(() => {});
    release();
    assert.equal(isGizmoDragActive(), true, "the newer drag still owns the slot");
    otherRelease();
    assert.equal(isGizmoDragActive(), false);
  });

  it("hands the slot to the newest drag", () => {
    const cancelled: string[] = [];
    beginGizmoDrag(() => cancelled.push("first"));
    const release = beginGizmoDrag(() => cancelled.push("second"));

    assert.equal(cancelActiveGizmoDrag(), true);
    assert.deepEqual(cancelled, ["second"]);
    release();
  });
});
