interface SummaryProps {
  visibleCount: number
  totalCount: number
  openCount: number
}

export function Summary({ visibleCount, totalCount, openCount }: SummaryProps) {
  return (
    <p className="summary" aria-live="polite">
      Showing {visibleCount} of {totalCount} tasks ({openCount} open)
    </p>
  )
}
