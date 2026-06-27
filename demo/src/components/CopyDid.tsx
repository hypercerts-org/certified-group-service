import { useState } from 'react'

interface CopyDidProps {
  did: string
  truncate?: boolean
  style?: React.CSSProperties
  /**
   * Text to show instead of the DID itself (the full DID is still what gets
   * copied, and appears in the hover tooltip). Used by {@link HandleId} compact
   * mode to render a handle that copies its DID. Takes precedence over
   * `truncate` when both are set.
   */
  label?: string
}

export function CopyDid({ did, truncate, style, label }: CopyDidProps) {
  const [copied, setCopied] = useState(false)

  const handleClick = () => {
    navigator.clipboard.writeText(did)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const display = label ?? (truncate ? `${did.slice(0, 20)}...` : did)

  // Signal a successful copy without changing the rendered text — swapping in
  // "Copied!" would change the element's width and reflow the surrounding
  // layout. Instead the text stays put and briefly flashes green; the tooltip
  // carries the "Copied!" wording.
  return (
    <span
      onClick={handleClick}
      title={copied ? 'Copied!' : `Click to copy: ${did}`}
      style={{
        cursor: 'pointer',
        fontFamily: 'monospace',
        borderBottom: '1px dashed #999',
        ...style,
        ...(copied ? { color: '#27ae60', borderBottomColor: '#27ae60' } : null),
      }}
    >
      {display}
    </span>
  )
}
