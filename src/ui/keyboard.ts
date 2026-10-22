/**
 * Shared DOM keyboard helpers (M4-T3).
 *
 * Two layers bind window-level keys — the playback transport (M4-T1: space,
 * arrows, Home, End) and the fly camera (M4-T3: WASD, arrows, Q/E, shift) — and
 * both have to answer the same question first: *is the user typing?* A transport
 * shortcut must never eat a space in a text field, and a fly key must never eat an
 * arrow from the scrubber's `<input type="range">`. One rule, one place, so the two
 * cannot drift apart.
 *
 * Not part of the data layer: it reads `EventTarget`/`HTMLElement` and is only
 * meaningful in a DOM. It is unit-tested in jsdom, which is the environment the
 * whole suite runs in anyway.
 */

/**
 * Whether a key event's target is somewhere typing should win: an input, a
 * textarea, a select or a contenteditable element.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}
