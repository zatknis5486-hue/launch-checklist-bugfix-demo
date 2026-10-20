interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
}

export function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <div className="field">
      <label htmlFor="task-search">Search tasks</label>
      <input
        id="task-search"
        type="search"
        placeholder="Filter by title"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
