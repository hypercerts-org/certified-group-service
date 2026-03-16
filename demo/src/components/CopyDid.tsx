import { useState } from 'react'

interface CopyDidProps {
  did: string
  truncate?: boolean
  style?: React.CSSProperties
}

export function CopyDid({ did, truncate, style }: CopyDidProps) {
  const [copied, setCopied] = useState(false)

  const handleClick = () => {
    navigator.clipboard.writeText(did)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const display = truncate ? `${did.slice(0, 20)}...` : did

  return (
    <span
      onClick={handleClick}
      title={copied ? 'Copied!' : `Click to copy: ${did}`}
      style={{
        cursor: 'pointer',
        fontFamily: 'monospace',
        borderBottom: '1px dashed #999',
        ...style,
      }}
    >
      {copied ? 'Copied!' : display}
    </span>
  )
}
