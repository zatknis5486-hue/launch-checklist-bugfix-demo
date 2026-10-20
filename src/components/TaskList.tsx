import type { Task } from '../types'

interface TaskListProps {
  tasks: Task[]
  onToggle: (id: string) => void
}

export function TaskList({ tasks, onToggle }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="empty">No tasks match the current filters.</p>
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => {
        const done = task.status === 'done'
        return (
          <li key={task.id} className={done ? 'task task--done' : 'task'}>
            <label className="task-main">
              <input
                type="checkbox"
                checked={done}
                onChange={() => onToggle(task.id)}
              />
              <span className="task-title" data-testid="task-title">
                {task.title}
              </span>
            </label>
            <span className="badge">{task.category}</span>
          </li>
        )
      })}
    </ul>
  )
}
