import { CopyDid } from './CopyDid'

/**
 * Display an atproto identity (a group or a member/actor) with the human-readable
 * **handle as the primary element** and the DID as a secondary one — DIDs are
 * opaque, handles are not, so handles lead everywhere.
 *
 * Layout, by available space:
 *  - `stacked` — handle on top, a copyable DID line beneath it. For headers and
 *    other places with vertical room.
 *  - `inline` — handle followed by a dimmed, copyable DID on the same line. For
 *    table cells / bars with horizontal room.
 *  - `compact` — handle only; the DID is shown on hover (native tooltip) and is
 *    still click-to-copy. For cramped spots where both would crowd.
 *
 * When the handle is unknown (not yet resolved, or a DID that declares none) the
 * DID becomes the primary element via {@link CopyDid}, so nothing is ever blank.
 */
type HandleIdLayout = 'stacked' | 'inline' | 'compact'

interface HandleIdProps {
  did: string
  /** The resolved handle, or null/undefined when unknown (falls back to the DID). */
  handle?: string | null
  layout?: HandleIdLayout
  /** Optional style for the primary (handle) element. */
  style?: React.CSSProperties
}

const handleStyle: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontWeight: 600,
}

export function HandleId({ did, handle, layout = 'inline', style }: HandleIdProps) {
  // No handle to lead with — show the DID as the primary, copyable element.
  if (!handle) {
    return <CopyDid did={did} style={style} />
  }

  if (layout === 'compact') {
    // Handle only; the DID is the tooltip and is what a click copies.
    return <CopyDid did={did} label={handle} style={{ ...handleStyle, ...style }} />
  }

  if (layout === 'stacked') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ ...handleStyle, ...style }}>{handle}</span>
        <CopyDid did={did} style={{ opacity: 0.6, fontSize: 11 }} />
      </span>
    )
  }

  // inline
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ ...handleStyle, ...style }} title={did}>
        {handle}
      </span>
      <CopyDid did={did} style={{ opacity: 0.6, fontSize: 11 }} />
    </span>
  )
}
