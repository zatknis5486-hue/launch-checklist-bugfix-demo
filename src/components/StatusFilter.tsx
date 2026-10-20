import type { StatusFilterValue } from '../types'

const OPTIONS: { value: StatusFilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
]

interface StatusFilterProps {
  value: StatusFilterValue
  onChange: (value: StatusFilterValue) => void
}

export function StatusFilter({ value, onChange }: StatusFilterProps) {
  return (
    <fieldset className="status-filter">
      <legend>Status</legend>
      <div className="chips">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={option.value === value ? 'chip chip--active' : 'chip'}
          >
            <input
              type="radio"
              name="status"
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
