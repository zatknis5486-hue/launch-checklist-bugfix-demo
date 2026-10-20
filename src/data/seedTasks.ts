import type { Task } from '../types'

/**
 * Synthetic seed data for the demo. These are typical pre-launch tasks for a
 * Vite + React app deployed on Vercel with Supabase. They do not describe any
 * real project.
 */
export const seedTasks: Task[] = [
  {
    id: 'env-supabase-url',
    title: 'Set VITE_SUPABASE_URL in Vercel project settings',
    category: 'Environment',
    status: 'open',
  },
  {
    id: 'env-supabase-anon-key',
    title: 'Set VITE_SUPABASE_ANON_KEY in Vercel project settings',
    category: 'Environment',
    status: 'done',
  },
  {
    id: 'db-rls-profiles',
    title: 'Enable RLS on profiles table',
    category: 'Database',
    status: 'open',
  },
  {
    id: 'auth-redirect-url',
    title: 'Configure Supabase auth redirect URL for the production domain',
    category: 'Auth',
    status: 'open',
  },
  {
    id: 'auth-email-template',
    title: 'Review the magic-link email template in Supabase Auth',
    category: 'Auth',
    status: 'done',
  },
  {
    id: 'build-local',
    title: 'Run production build locally',
    category: 'Build',
    status: 'done',
  },
  {
    id: 'build-ts-errors',
    title: 'Fix TypeScript errors that block the production build',
    category: 'Build',
    status: 'open',
  },
  {
    id: 'content-404',
    title: 'Add a 404 page and an error boundary',
    category: 'Content',
    status: 'open',
  },
  {
    id: 'ops-uptime',
    title: 'Set up an uptime check for the production URL',
    category: 'Monitoring',
    status: 'open',
  },
]
