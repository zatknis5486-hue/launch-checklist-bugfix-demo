import { useMemo, useState } from 'react'
import { SearchBox } from './components/SearchBox'
import { StatusFilter } from './components/StatusFilter'
import { Summary } from './components/Summary'
import { TaskList } from './components/TaskList'
import { seedTasks } from './data/seedTasks'
import { filterTasks } from './lib/filterTasks'
import type { StatusFilterValue, Task } from './types'

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(seedTasks)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilterValue>('all')

  // Derived data: computed from the current inputs on every relevant change,
  // instead of being copied into its own state and synced with an effect.
  const visible = useMemo(
    () => filterTasks(tasks, query, status),
    [tasks, query, status],
  )

  function toggleTask(id: string) {
    setTasks((previous) =>
      previous.map((task) =>
        task.id === id
          ? { ...task, status: task.status === 'done' ? 'open' : 'done' }
          : task,
      ),
    )
  }

  const openCount = tasks.filter((task) => task.status === 'open').length

  return (
    <main className="app">
      <header className="app-header">
        <h1>Launch Checklist</h1>
        <p className="tagline">
          Pre-launch tasks for a Vite + React app on Vercel and Supabase.
          Synthetic demo data; this is not a real project.
        </p>
      </header>

      <section className="controls" aria-label="Filters">
        <SearchBox value={query} onChange={setQuery} />
        <StatusFilter value={status} onChange={setStatus} />
      </section>

      <Summary
        visibleCount={visible.length}
        totalCount={tasks.length}
        openCount={openCount}
      />

      <TaskList tasks={visible} onToggle={toggleTask} />
    </main>
  )
}
