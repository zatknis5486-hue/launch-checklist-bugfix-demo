/**
 * Human-written narrative for the case write-up. build-case.mjs merges this
 * with the facts it measures itself (diff, test output, commit hashes).
 *
 * Keep it honest: this is a self-created demo. The bug was introduced on
 * purpose to produce a reproducible before/after; it is not from any client.
 */
export const caseContent = {
  label: 'Self-created technical demo — not client work',

  title: 'Search and status filters silently ignored (stale derived state)',

  summary:
    'In a small React checklist app, the search box and the status filter looked broken: ' +
    'typing or picking a status changed nothing on screen. The filtered list was kept in its own ' +
    'useState and refreshed by a useEffect that only watched the task array, so it never re-ran ' +
    'when the query or the status changed.',

  symptom:
    'You type "redirect" into the search box and all nine tasks stay on screen; you click the ' +
    '"Open" filter and the done tasks stay too. The summary line still says "Showing 9 of 9 tasks". ' +
    'As soon as you tick any checkbox, the list suddenly applies the filters you chose earlier, ' +
    'which makes the bug look intermittent and hard to describe.',

  reproSteps: [
    'Check out the bug commit: git checkout demo-bug (then npm install if you have not already).',
    'Start the app: npm run dev, and open the printed localhost URL in a browser.',
    'Type "redirect" in the "Search tasks" box. Expected: only "Configure Supabase auth redirect URL for the production domain" remains. Actual: all 9 tasks stay visible and the summary still reads "Showing 9 of 9 tasks (6 open)".',
    'Click the "Open" status chip. Expected: the 3 done tasks disappear. Actual: nothing changes.',
    'Tick any task checkbox. Actual: the list now suddenly applies both filters, because toggling changes the task array, which is the only thing the effect watches.',
    'Optional: run npm run lint on this commit. ESLint reports react-hooks/exhaustive-deps on the useEffect in src/App.tsx, naming the missing "query" and "status" dependencies.',
    'Return to the fixed code with git checkout main and repeat steps 2 to 4: filtering now happens as you type and as you click.',
  ],

  rootCause:
    'src/App.tsx stored the filtered list as separate state, ' +
    'const [visible, setVisible] = useState<Task[]>(tasks), and synchronised it with ' +
    'useEffect(() => { setVisible(filterTasks(tasks, query, status)) }, [tasks]). ' +
    'The dependency array lists only tasks, so React re-runs the effect when a task is toggled ' +
    'but not when query or status change. The inputs themselves render correctly because they ' +
    'have their own state, so the UI looks responsive while the list silently shows stale data. ' +
    'The react-hooks/exhaustive-deps lint rule flagged exactly this line in the first commit, ' +
    'but a warning is easy to scroll past.',

  fix:
    'Replace the state-plus-effect pair with a derived value: ' +
    'const visible = useMemo(() => filterTasks(tasks, query, status), [tasks, query, status]). ' +
    'The filtered list is now computed during render from its three inputs, so there is no second ' +
    'copy of the data that can fall out of sync and no extra render pass after each change. ' +
    'The commit also adds a regression test (src/App.test.tsx) that drives the real UI with ' +
    'Testing Library: it types into the search box and selects the Open filter, then asserts on ' +
    'the rendered titles. Unit tests for the pure filterTasks helper (src/lib/filterTasks.test.ts) ' +
    'pin down the matching rules.',

  lesson:
    'If a value can be computed from props or state, compute it during render (a plain expression ' +
    'or useMemo) instead of copying it into state and syncing it with an effect. Treat ' +
    'react-hooks/exhaustive-deps warnings as bugs until proven otherwise, and cover the user-visible ' +
    'behaviour with a test that fails before the fix.',

  testFile: 'src/App.test.tsx',

  /**
   * Images under case/screenshots/, written by `npm run case:screenshots`
   * (scripts/capture-screenshots.mjs) together with manifest.json. Only the
   * words here are hand-written; build-case.mjs takes the dimensions, the
   * commit each image was taken from and the summary line read from the page
   * at capture time from the manifest, and refuses to build when they no
   * longer match this repository. Paths are relative to the repo root.
   * Leave the list empty to publish without screenshots.
   */
  screenshots: [
    {
      file: 'case/screenshots/before-typed.png',
      title: 'Before the fix: "redirect" typed, nothing filtered',
      alt:
        'The Launch Checklist app at the demo-bug commit with "redirect" typed in the search box: ' +
        'all nine tasks are still listed and the summary reads "Showing 9 of 9 tasks (6 open)".',
      caption:
        'Before the fix. "redirect" has been typed into the search box, yet all 9 tasks are still ' +
        'listed and the summary still says 9 of 9.',
    },
    {
      file: 'case/screenshots/before-after-toggle.png',
      title: 'Before the fix: one checkbox ticked, the stale filter suddenly applies',
      alt:
        'The same app after ticking the checkbox of "Configure Supabase auth redirect URL for the ' +
        'production domain": only that task is listed, struck through, and the summary reads ' +
        '"Showing 1 of 9 tasks (5 open)".',
      caption:
        'Still before the fix. Ticking one checkbox changes the task array, the effect finally re-runs, ' +
        'and the list suddenly applies the search typed earlier. This is what made the bug look intermittent.',
    },
    {
      file: 'case/screenshots/after-typed.png',
      title: 'After the fix: the same keystrokes filter as you type',
      alt:
        'The fixed app with "redirect" typed in the search box: only "Configure Supabase auth redirect ' +
        'URL for the production domain" is listed and the summary reads "Showing 1 of 9 tasks (6 open)".',
      caption:
        'After the fix. The same keystrokes narrow the list as you type: 1 of 9 tasks shown, ' +
        'no checkbox touched.',
    },
  ],

  repoUrl: 'https://github.com/zatknis5486-hue/launch-checklist-bugfix-demo',
}
