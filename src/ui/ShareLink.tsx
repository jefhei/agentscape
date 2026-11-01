import { useCallback, useState } from 'react'

/**
 * The share control (M6-T2) — the render half of the shareable URL.
 *
 * One button, one status line. It decides no rule: **what** a link says is
 * `src/persist/share.ts` (pure, unit-tested), and **which** view is current is the
 * autosave's capture (the same value that survives a reload). This component only
 * asks for a href at the moment of the click and puts it on the clipboard.
 *
 * ## Why the href is a callback, not a prop
 *
 * A share link names the *live* view: the playhead moves every frame while a run
 * plays and the camera on every drag. Passing a pre-built string would either
 * rebuild it on every render (a base64 encode per frame) or, worse, freeze the
 * link at the view of the render that mounted the button. A callback is invoked
 * once, on click, and reads the current view — nothing to invalidate, nothing to
 * keep in sync.
 *
 * ## Failure is stated, not hidden
 *
 * `navigator.clipboard` is absent outside a secure context and can reject when the
 * document is not focused; both read as "copy failed". The button then says so and
 * exposes the link it built (`data-share-href`) so it can still be selected from
 * the page — the one thing a share button must not do is claim a copy that did not
 * happen.
 *
 * The look is CSS's and the human's (M5-T5); nothing here asserts it.
 */

/** What the last click did. */
export type ShareStatus = 'idle' | 'copied' | 'failed'

/** The status line's text; empty while idle, so the header stays quiet. */
function shareStatusLabel(status: ShareStatus): string {
  if (status === 'copied') return 'Link copied'
  if (status === 'failed') return 'Copy failed — the link is on the button'
  return ''
}

export interface ShareLinkProps {
  /** Build the link for the view as it stands **now** (invoked on click). */
  buildHref: () => string
}

export default function ShareLink({ buildHref }: ShareLinkProps) {
  const [status, setStatus] = useState<ShareStatus>('idle')
  const [href, setHref] = useState<string | null>(null)

  const copy = useCallback(() => {
    const link = buildHref()
    setHref(link)
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) {
      setStatus('failed')
      return
    }
    void clipboard.writeText(link).then(
      () => setStatus('copied'),
      () => setStatus('failed'),
    )
  }, [buildHref])

  return (
    <div
      className="share-link"
      data-testid="share-link"
      data-share-href={href ?? undefined}
    >
      <button
        type="button"
        className="share-button"
        data-testid="share-button"
        data-status={status}
        title="Copy a link that reopens this run, this layout and this view"
        onClick={copy}
      >
        Share view
      </button>
      <span
        className="share-status"
        data-testid="share-status"
        role="status"
        aria-live="polite"
      >
        {shareStatusLabel(status)}
      </span>
    </div>
  )
}
