import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { seedTasks } from './data/seedTasks'

/** Titles currently rendered in the task list, in display order. */
function visibleTitles(): string[] {
  return screen.queryAllByTestId('task-title').map((el) => el.textContent ?? '')
}

const openTitles = seedTasks.filter((t) => t.status === 'open').map((t) => t.title)
const doneTitles = seedTasks.filter((t) => t.status === 'done').map((t) => t.title)

describe('Launch Checklist filters', () => {
  it('shows every seeded task before any filter is applied', () => {
    render(<App />)
    expect(visibleTitles()).toEqual(seedTasks.map((t) => t.title))
  })

  // Regression: typing in the search box used to leave the list unchanged.
  it('filters the list as you type in the search box', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByRole('searchbox', { name: /search tasks/i }), 'redirect')

    expect(visibleTitles()).toEqual([
      'Configure Supabase auth redirect URL for the production domain',
    ])
    expect(screen.getByText(/showing 1 of 9 tasks/i)).toBeInTheDocument()
  })

  // Regression: choosing a status used to leave the list unchanged.
  it('hides done tasks when the Open status filter is selected', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('radio', { name: 'Open' }))

    const titles = visibleTitles()
    for (const title of doneTitles) {
      expect(titles).not.toContain(title)
    }
    expect(titles).toEqual(openTitles)
  })

  it('combines the search query with the status filter', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByRole('searchbox', { name: /search tasks/i }), 'supabase')
    await user.click(screen.getByRole('radio', { name: 'Done' }))

    expect(visibleTitles()).toEqual([
      'Set VITE_SUPABASE_ANON_KEY in Vercel project settings',
      'Review the magic-link email template in Supabase Auth',
    ])
  })

  it('toggling a task updates the open count', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByText(/6 open/)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Enable RLS on profiles table' }))

    expect(screen.getByText(/5 open/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Enable RLS on profiles table' })).toBeChecked()
  })
})
