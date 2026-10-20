export type TaskStatus = 'open' | 'done'

export type TaskCategory =
  | 'Environment'
  | 'Database'
  | 'Auth'
  | 'Build'
  | 'Content'
  | 'Monitoring'

export interface Task {
  id: string
  title: string
  category: TaskCategory
  status: TaskStatus
}

/** Value of the status filter control. */
export type StatusFilterValue = 'all' | TaskStatus
