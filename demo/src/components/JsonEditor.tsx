interface Props {
  value: string
  onChange: (v: string) => void
  rows?: number
}

export function JsonEditor({ value, onChange, rows = 12 }: Props) {
  let isValid = true
  try {
    if (value.trim()) JSON.parse(value)
  } catch {
    isValid = false
  }

  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{
        width: '100%',
        fontFamily: 'monospace',
        fontSize: 13,
        padding: 12,
        border: `2px solid ${isValid ? '#ccc' : '#e74c3c'}`,
        borderRadius: 6,
        resize: 'vertical',
        background: '#fafafa',
      }}
    />
  )
}
