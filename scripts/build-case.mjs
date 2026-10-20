#!/usr/bin/env node
/**
 * Builds the case write-up from facts measured in this repository:
 *
 *   - runs the regression proof (scripts/prove-regression.mjs) and keeps the
 *     trimmed, colour-free output of both test runs;
 *   - takes the real diff between the `demo-bug` and `demo-fix` tags
 *     (src/ only, test files excluded);
 *   - reads both commit hashes and messages;
 *   - reads the exact versions of the stack from node_modules;
 *   - runs ESLint on the bug version of the changed file(s), to show the
 *     warning that was already pointing at the problem.
 *
 * It then writes case/case.json (machine-readable, fixed field set) and
 * case/CASE_STUDY.md (human-readable). Nothing is written if the proof does
 * not hold (bug run must fail, fixed run must pass).
 *
 * Usage: node scripts/build-case.mjs   (or: npm run case:build)
 *        Set GIT_EXE if git is not on PATH.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { caseContent } from './case-content.mjs'
import { BUG_REF, FIX_REF, git, proveRegression, repoRoot } from './prove-regression.mjs'

const caseDir = path.join(repoRoot, 'case')

// ---------------------------------------------------------------------------
// Output cleaning
// ---------------------------------------------------------------------------

function repoRootVariants() {
  const variants = new Set([repoRoot, repoRoot.replace(/\\/g, '/')])
  try {
    const real = realpathSync.native(repoRoot)
    variants.add(real)
    variants.add(real.replace(/\\/g, '/'))
  } catch {
    // ignore: realpath is only used to redact extra spellings of the path
  }
  // Longest first so that a prefix never shadows a longer variant.
  return [...variants].sort((a, b) => b.length - a.length)
}

/** Replace every spelling of the local repo path with <repo>. */
function redactPaths(text) {
  let out = text
  for (const variant of repoRootVariants()) out = out.split(variant).join('<repo>')
  return out
}

/**
 * Strip ANSI codes, normalise newlines, redact local paths, collapse blank
 * runs, and keep the useful part: for a failing run that is everything up to
 * the end of the first failure's details (the file list, the summary and the
 * first assertion with its diff); for anything long without that structure,
 * the head and the tail.
 */
export function trimOutput(raw, { maxLines = 60, headLines = 44, tailLines = 8 } = {}) {
  const text = redactPaths(stripVTControlCharacters(raw).replace(/\r\n?/g, '\n'))
  const lines = []
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '' && lines[lines.length - 1] === '') continue
    lines.push(trimmed)
  }
  while (lines.length && lines[0] === '') lines.shift()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  if (lines.length <= maxLines) return lines.join('\n')

  const firstSeparator = lines.findIndex((line) => /^⎯+\[1\/\d+\]⎯*$/.test(line))
  if (firstSeparator > 0 && firstSeparator < maxLines) {
    const remaining = lines.length - firstSeparator - 1
    return [
      ...lines.slice(0, firstSeparator + 1),
      `… [${remaining} more lines trimmed: details of the remaining failing tests] …`,
    ].join('\n')
  }

  const trimmedCount = lines.length - headLines - tailLines
  return [
    ...lines.slice(0, headLines),
    `… [${trimmedCount} lines trimmed] …`,
    ...lines.slice(-tailLines),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Facts measured from the repository
// ---------------------------------------------------------------------------

function commitInfo(ref) {
  return {
    hash: git(['rev-parse', `${ref}^{commit}`]).stdout.trim(),
    message: git(['log', '-1', '--format=%s', ref]).stdout.trim(),
  }
}

function sourceDiff() {
  // ":(exclude)" pathspecs drop the test files; verified against this repo's
  // git (2.56). If your git predates pathspec magic, filter by hand.
  return git(['diff', BUG_REF, FIX_REF, '--', 'src', ':(exclude)*.test.ts', ':(exclude)*.test.tsx']).stdout.replace(
    /\r\n?/g,
    '\n',
  )
}

function installedVersion(pkg) {
  try {
    const file = path.join(repoRoot, 'node_modules', ...pkg.split('/'), 'package.json')
    return JSON.parse(readFileSync(file, 'utf8')).version
  } catch {
    return 'TO_VERIFY: version not found in node_modules'
  }
}

function stack() {
  return [
    `Vite ${installedVersion('vite')}`,
    `React ${installedVersion('react')}`,
    `TypeScript ${installedVersion('typescript')}`,
    `Vitest ${installedVersion('vitest')}`,
    `Testing Library (React) ${installedVersion('@testing-library/react')}`,
    `ESLint ${installedVersion('eslint')} with eslint-plugin-react-hooks ${installedVersion('eslint-plugin-react-hooks')}`,
  ]
}

/** ESLint output for the bug version of each modified file, via stdin. */
function lintOutputBefore(files) {
  const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js')
  const chunks = []
  for (const file of files) {
    if (file.status !== 'M') continue
    const content = git(['show', `${BUG_REF}:${file.path}`], { binary: true }).stdout
    const result = spawnSync(
      process.execPath,
      [eslintBin, '--no-color', '--format', 'stylish', '--stdin', '--stdin-filename', file.path],
      { cwd: repoRoot, input: content, encoding: 'utf8', windowsHide: true },
    )
    if (result.error) {
      chunks.push(`(could not run ESLint for ${file.path}: ${result.error.message})`)
      continue
    }
    const text = redactPaths(stripVTControlCharacters(`${result.stdout}${result.stderr}`)).trim()
    chunks.push(text || `(ESLint reported nothing for ${BUG_REF}:${file.path})`)
  }
  return chunks.join('\n\n')
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fence(lang, body) {
  return `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``
}

function renderCaseStudy(c, extras) {
  const steps = c.reproSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  const stackList = c.stack.map((s) => `- ${s}`).join('\n')
  const changedFiles = extras.files.map((f) => `\`${f.path}\``).join(', ')

  return `# ${c.title}

> **${c.label}.** The bug in this repository was introduced on purpose to build a
> reproducible before/after example. It is not taken from anyone's codebase, and no
> client was involved. Everything below was measured in this repository by
> \`npm run case:build\` on ${c.generatedAt}.

| | |
|---|---|
| Bug commit | \`${c.commits.bug.hash}\` — ${c.commits.bug.message} (tag \`${BUG_REF}\`) |
| Fix commit | \`${c.commits.fix.hash}\` — ${c.commits.fix.message} (tag \`${FIX_REF}\`) |
| Regression test | \`${c.testFile}\` |
| Source files changed by the fix | ${changedFiles} |
| Public repository | ${c.repoUrl} |

## Stack

${stackList}

## Summary

${c.summary}

## What the user saw

${c.symptom}

## How to reproduce

${steps}

## Root cause

${c.rootCause}

## The fix

${c.fix}

Diff between \`${BUG_REF}\` and \`${FIX_REF}\` (\`src/\` only, test files excluded):

${fence('diff', c.diff)}

## Proof: the regression test fails before and passes after

\`npm run prove\` (scripts/prove-regression.mjs) temporarily writes the \`${BUG_REF}\`
version of ${changedFiles} into the working tree, runs the test suite from HEAD against
it, restores the file, and runs the suite again. It exits 0 only when the first run fails
and the second passes. Local paths are shown as \`<repo>\`; long output is trimmed where marked.

### Before: tests run against the \`${BUG_REF}\` source

${fence('text', c.testOutputBefore)}

### After: tests run on \`${FIX_REF}\`

${fence('text', c.testOutputAfter)}

### The warning that was already there

ESLint output for the \`${BUG_REF}\` version of the changed file (rule \`react-hooks/exhaustive-deps\`,
configured at its default level, "warn"):

${fence('text', extras.lintBefore || '(not captured)')}

## Lesson

${c.lesson}

## Screenshot instructions (no screenshots are included yet)

This write-up was generated without a browser, so it contains **no screenshots**. To add
honest before/after screenshots yourself:

1. \`git checkout ${BUG_REF}\` (detached HEAD is fine). Run \`npm run dev\` and open the printed
   localhost URL. Use a plain browser window with no personal bookmarks or extensions visible.
2. Type \`redirect\` in the **Search tasks** box. The list still shows all 9 tasks and the summary
   still reads "Showing 9 of 9 tasks (6 open)". Capture the app area and save it as
   \`case/screenshots/before-search.png\`.
3. Click the **Open** chip. The 3 done tasks are still listed. Save as
   \`case/screenshots/before-status.png\`.
4. Stop the dev server. \`git checkout main\` and run \`npm run dev\` again.
5. Repeat step 2: only one task remains and the summary reads "Showing 1 of 9 tasks (6 open)".
   Save as \`case/screenshots/after-search.png\`.
6. Repeat step 3 (clear the search box first): 6 open tasks remain. Save as
   \`case/screenshots/after-status.png\`.
7. Keep the window size identical for all four captures, crop to the app, then reference the
   images from this file under a new "Screenshots" heading and commit them together with the
   images. Do not present them as anything other than captures of this demo app.

## Commits

- \`${c.commits.bug.hash}\` ${c.commits.bug.message}
- \`${c.commits.fix.hash}\` ${c.commits.fix.message}

Note for the publisher: rewriting authorship before publishing (see README) changes these hashes;
rerun \`npm run case:build\` afterwards so this file and \`case.json\` match the published history.
`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const proof = proveRegression()
  if (!proof.ok) {
    console.error('\nbuild-case: the regression proof did not hold; case files were NOT written.')
    process.exitCode = 1
    return
  }

  const testOutputBefore = trimOutput(proof.before.output)
  const testOutputAfter = trimOutput(proof.after.output)

  // Sanity checks on what we are about to publish.
  if (!/AssertionError|FAIL\b|\bfailed\b/.test(testOutputBefore)) {
    throw new Error('Expected the "before" output to contain a failing assertion; refusing to write case files.')
  }
  if (!/\bpassed\b/.test(testOutputAfter) || /\bfailed\b/.test(testOutputAfter)) {
    throw new Error('Expected the "after" output to show only passing tests; refusing to write case files.')
  }

  const testFileTracked = git(['ls-files', '--error-unmatch', caseContent.testFile], { allowFailure: true })
  if (testFileTracked.status !== 0) {
    throw new Error(`Regression test ${caseContent.testFile} is not tracked by git.`)
  }

  const caseJson = {
    label: caseContent.label,
    title: caseContent.title,
    stack: stack(),
    summary: caseContent.summary,
    symptom: caseContent.symptom,
    reproSteps: caseContent.reproSteps,
    rootCause: caseContent.rootCause,
    fix: caseContent.fix,
    lesson: caseContent.lesson,
    diff: sourceDiff(),
    testFile: caseContent.testFile,
    testOutputBefore,
    testOutputAfter,
    commits: { bug: commitInfo(BUG_REF), fix: commitInfo(FIX_REF) },
    repoUrl: caseContent.repoUrl,
    generatedAt: new Date().toISOString(),
  }

  for (const [key, value] of Object.entries(caseJson)) {
    const empty =
      value == null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)
    if (empty) throw new Error(`case.json field "${key}" is empty; refusing to write case files.`)
  }

  const lintBefore = lintOutputBefore(proof.files)

  mkdirSync(caseDir, { recursive: true })
  const jsonPath = path.join(caseDir, 'case.json')
  const mdPath = path.join(caseDir, 'CASE_STUDY.md')
  writeFileSync(jsonPath, `${JSON.stringify(caseJson, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderCaseStudy(caseJson, { files: proof.files, lintBefore }), 'utf8')

  console.log(`\nWrote ${path.relative(repoRoot, jsonPath)} and ${path.relative(repoRoot, mdPath)}.`)
}

try {
  main()
} catch (error) {
  console.error(`\nbuild-case: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
