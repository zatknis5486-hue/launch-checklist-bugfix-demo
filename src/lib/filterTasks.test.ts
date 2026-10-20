import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import { filterTasks } from './filterTasks'

const tasks: Task[] = [
  { id: 'a', title: 'Enable RLS on profiles table', category: 'Database', status: 'open' },
  { id: 'b', title: 'Run production build locally', category: 'Build', status: 'done' },
  { id: 'c', title: 'Configure auth redirect URL', category: 'Auth', status: 'open' },
  { id: 'd', title: 'Set VITE_SUPABASE_URL in Vercel', category: 'Environment', status: 'done' },
]

const ids = (list: Task[]) => list.map((t) => t.id)

describe('filterTasks', () => {
  it('returns every task for an empty query and the All filter', () => {
    expect(ids(filterTasks(tasks, '', 'all'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('matches the query against the title, case-insensitively', () => {
    expect(ids(filterTasks(tasks, 'REDIRECT', 'all'))).toEqual(['c'])
    expect(ids(filterTasks(tasks, 'url', 'all'))).toEqual(['c', 'd'])
  })

  it('ignores surrounding whitespace in the query', () => {
    expect(ids(filterTasks(tasks, '  rls  ', 'all'))).toEqual(['a'])
  })

  it('keeps only tasks with the selected status', () => {
    expect(ids(filterTasks(tasks, '', 'open'))).toEqual(['a', 'c'])
    expect(ids(filterTasks(tasks, '', 'done'))).toEqual(['b', 'd'])
  })

  it('applies the query and the status filter together', () => {
    expect(ids(filterTasks(tasks, 'url', 'done'))).toEqual(['d'])
    expect(ids(filterTasks(tasks, 'url', 'open'))).toEqual(['c'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterTasks(tasks, 'nothing like this', 'all')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const copy = [...tasks]
    filterTasks(tasks, 'rls', 'open')
    expect(tasks).toEqual(copy)
  })
})
