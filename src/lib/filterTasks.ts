import type { StatusFilterValue, Task } from '../types'

/**
 * Pure function: returns the tasks whose title contains `query`
 * (case-insensitive, surrounding whitespace ignored) and whose status matches
 * the selected filter. Never mutates the input.
 */
export function filterTasks(
  tasks: Task[],
  query: string,
  status: StatusFilterValue,
): Task[] {
  const needle = query.trim().toLowerCase()
  return tasks.filter((task) => {
    if (status !== 'all' && task.status !== status) return false
    if (needle !== '' && !task.title.toLowerCase().includes(needle)) return false
    return true
  })
}
