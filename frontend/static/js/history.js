/* history.js — note navigation history (GUI-2).
 *
 * Single owner of the back/forward stacks. Session-local by design
 * (no persistence — restart starts fresh). Global across tabs: RTNote's
 * tabs share one workspace, so per-tab history would surprise more than
 * help at this scale.
 *
 * The recording choke point is openNoteInEditor (every real note switch
 * flows through it); back/forward navigation sets a suppression flag so
 * programmatic opens don't re-record.
 */
const NavHistory = (() => {
  "use strict";

  let stack = [];      // note ids, oldest → newest
  let index = -1;      // current position
  let suppress = false; // true while a back/forward-driven open is in flight
  let onChange = null;  // UI hook (button enable/disable)

  function notify() { if (typeof onChange === "function") onChange(); }

  /* Record a note activation. Dedupes consecutive repeats and truncates
     the forward stack (A→B→C, back to B, open D ⇒ D replaces C). */
  function push(noteId) {
    if (suppress) return;
    noteId = Number(noteId);
    if (isNaN(noteId)) return;
    if (index >= 0 && stack[index] === noteId) return;
    stack = stack.slice(0, index + 1);
    stack.push(noteId);
    index++;
    if (stack.length > 100) {
      stack.splice(0, stack.length - 100);
      index = stack.length - 1;
    }
    notify();
  }

  function canBack() { return index > 0; }
  function canForward() { return index < stack.length - 1; }

  /* Next id in a direction without moving (existence pre-check by caller). */
  function peek(dir) {
    const i = index + dir;
    return i >= 0 && i < stack.length ? stack[i] : null;
  }

  /* Move in a direction and suppress recording until endNavigate(). */
  function step(dir) {
    const i = index + dir;
    if (i < 0 || i >= stack.length) return null;
    index = i;
    suppress = true;
    notify();
    return stack[i];
  }

  /* Drop a dead entry (deleted/missing note) without navigating. */
  function skip(dir) {
    const i = index + dir;
    if (i < 0 || i >= stack.length) return null;
    index = i;
    notify();
    return stack[i];
  }

  function endNavigate() { suppress = false; }

  /* Recent notes, most recent first, excluding the current one —
     powers the empty-state of the jump/search overlay. */
  function recent(count = 8) {
    const out = [];
    for (let i = stack.length - 1; i >= 0 && out.length < count; i--) {
      if (i === index) continue;
      if (!out.includes(stack[i])) out.push(stack[i]);
    }
    return out;
  }

  return {
    push, peek, step, skip, endNavigate,
    canBack, canForward, recent,
    set onChange(fn) { onChange = fn; },
  };
})();
