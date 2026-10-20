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
 *     warning that was already pointing at the problem;
 *   - pairs the screenshots listed in case-content.mjs with what
 *     scripts/capture-screenshots.mjs recorded in case/screenshots/manifest.json
 *     (dimensions, the commit each image was taken from, the summary line read
 *     from the page) and refuses to build when they no longer match the repo.
 *
 * It then writes case/case.json (machine-readable, fixed field set) and
 * case/CASE_STUDY.md (human-readable). Nothing is written if the proof does
 * not hold (bug run must fail, fixed run must pass, judged from Vitest's
 * parsed report), or if the non-test files under src/ at HEAD differ from
 * `demo-fix`, because then the diff (tag to tag) and the "after" test run
 * (measured on HEAD) would describe different code.
 *
 * The output is deterministic: timings in the test output are replaced by
 * placeholders and generatedAt is a date, so rerunning on the same history
 * rewrites both files byte for byte and leaves the git tree clean.
 *
 * Usage: node scripts/build-case.mjs   (or: npm run case:build)
 *        Set GIT_EXE if git is not on PATH.
 *        --allow-head-drift   write the case even though HEAD's src/ differs
 *                             from demo-fix; records "headMatchesFixTag": false
 *                             in case.json and adds a visible note to the study.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { MANIFEST_FILE, SCREENSHOT_DIR, readPngSize } from './capture-screenshots.mjs'
import { caseContent } from './case-content.mjs'
import { BUG_REF, FIX_REF, SOURCE_PATHSPEC, describeRun, git, proveRegression, repoRoot } from './prove-regression.mjs'

const caseDir = path.join(repoRoot, 'case')
const ALLOW_HEAD_DRIFT_FLAG = '--allow-head-drift'

/** Repo-relative path with forward slashes, for messages and the write-up. */
function rel(p) {
  return path.relative(repoRoot, p).replace(/\\/g, '/')
}

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
 * Replace the wall-clock parts of a Vitest output line with fixed placeholders
 * so that two runs on the same history produce identical text:
 *   "   Start at  10:04:17"            -> "   Start at  <time>"
 *   "   Duration  2.87s (transform …)" -> "   Duration  <elapsed>"
 *   " ✓ src/App.test.tsx (5 tests) 628ms" and per-test "… 191ms" -> "… <n>ms"
 */
function normaliseTimings(line) {
  return line
    .replace(/^(\s*)Start at\s+\S+$/, '$1Start at  <time>')
    .replace(/^(\s*)Duration\s+.*$/, '$1Duration  <elapsed>')
    .replace(/^(\s*[✓×❯↓].*?) \d+(?:\.\d+)?ms$/, '$1 <n>ms')
}

/**
 * Strip ANSI codes, normalise newlines, redact local paths, replace timings,
 * collapse blank runs, and keep the useful part: for a failing run that is
 * everything up to the end of the first failure's details (the file list, the
 * summary and the first assertion with its diff); for anything long without
 * that structure, the head and the tail.
 */
export function trimOutput(raw, { maxLines = 60, headLines = 44, tailLines = 8 } = {}) {
  const text = redactPaths(stripVTControlCharacters(raw).replace(/\r\n?/g, '\n'))
  const lines = []
  for (const line of text.split('\n')) {
    const trimmed = normaliseTimings(line.trimEnd())
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
  // Same pathspec as prove-regression's HEAD-vs-tag check (src/, test files excluded).
  return git(['diff', BUG_REF, FIX_REF, '--', ...SOURCE_PATHSPEC]).stdout.replace(/\r\n?/g, '\n')
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
// Screenshots (captured by scripts/capture-screenshots.mjs)
// ---------------------------------------------------------------------------

const RECAPTURE = 'Rerun "npm run case:screenshots" (then "npm run case:build").'

/**
 * Pairs each screenshot listed in case-content.mjs with what the capture
 * script recorded in case/screenshots/manifest.json and checks that both still
 * describe this repository: the file exists and is the PNG the manifest
 * measured, a "before" image was taken at the demo-bug commit, and an "after"
 * image at a commit whose non-test src/ is identical to demo-fix. The words
 * (title, alt, caption) come from case-content; the facts (size, commit, the
 * summary line read from the page) come from the manifest.
 * Returns null when case-content lists no screenshots.
 */
function screenshotFacts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`case-content.mjs lists screenshots but ${rel(MANIFEST_FILE)} could not be read (${error.message}). ${RECAPTURE}`)
  }
  const viewport = manifest && manifest.viewport
  if (
    !manifest ||
    typeof manifest.shots !== 'object' ||
    typeof manifest.capturedAt !== 'string' ||
    typeof manifest.browser !== 'string' ||
    typeof manifest.query !== 'string' ||
    !viewport ||
    ![viewport.width, viewport.height, viewport.deviceScaleFactor].every((n) => typeof n === 'number')
  ) {
    throw new Error(`${rel(MANIFEST_FILE)} is not shaped like the capture script's output. ${RECAPTURE}`)
  }

  const bugHash = git(['rev-parse', `${BUG_REF}^{commit}`]).stdout.trim()
  const images = entries.map((entry) => {
    for (const key of ['file', 'title', 'alt', 'caption']) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        throw new Error(`Screenshot entry ${JSON.stringify(entry.file)} in case-content.mjs needs a non-empty "${key}".`)
      }
    }
    const absolute = path.resolve(repoRoot, entry.file)
    const inside = path.relative(SCREENSHOT_DIR, absolute)
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`Screenshot ${entry.file} must live under ${rel(SCREENSHOT_DIR)}/.`)
    }
    const name = path.basename(absolute)
    const shot = manifest.shots[name]
    if (!shot || typeof shot !== 'object') {
      throw new Error(`${entry.file} is not recorded in ${rel(MANIFEST_FILE)}. ${RECAPTURE}`)
    }
    let size
    try {
      size = readPngSize(readFileSync(absolute))
    } catch (error) {
      throw new Error(`${entry.file}: ${error.message}. ${RECAPTURE}`)
    }
    if (size.width !== shot.width || size.height !== shot.height) {
      throw new Error(
        `${entry.file} is ${size.width}x${size.height} px but the manifest recorded ${shot.width}x${shot.height}. ${RECAPTURE}`,
      )
    }
    if (typeof shot.commit !== 'string' || !/^[0-9a-f]{40}$/.test(shot.commit)) {
      throw new Error(`${entry.file}: the manifest has no commit hash for it. ${RECAPTURE}`)
    }
    if (shot.ref === BUG_REF) {
      if (shot.commit !== bugHash) {
        throw new Error(`${entry.file} was captured at ${shot.commit}, but ${BUG_REF} now points at ${bugHash}. ${RECAPTURE}`)
      }
    } else {
      const same = git(['diff', '--quiet', FIX_REF, shot.commit, '--', ...SOURCE_PATHSPEC], { allowFailure: true })
      if (same.status !== 0) {
        const why = same.status === 1 ? 'differs from' : 'could not be compared with'
        throw new Error(`${entry.file} was captured at ${shot.commit}, whose non-test src/ ${why} ${FIX_REF}. ${RECAPTURE}`)
      }
    }
    const observed = shot.observed
    if (!observed || typeof observed.summary !== 'string' || !Array.isArray(observed.visible)) {
      throw new Error(`${entry.file}: the manifest entry lacks the page state read at capture time. ${RECAPTURE}`)
    }
    return {
      file: entry.file.replace(/\\/g, '/'),
      title: entry.title,
      alt: entry.alt,
      caption: entry.caption,
      width: size.width,
      height: size.height,
      ref: shot.ref === BUG_REF ? BUG_REF : 'HEAD',
      commit: shot.commit,
      summary: observed.summary,
      visibleTasks: observed.visible.length,
    }
  })

  return {
    capturedAt: manifest.capturedAt,
    tool: typeof manifest.tool === 'string' ? manifest.tool : 'scripts/capture-screenshots.mjs',
    browser: manifest.browser,
    viewport: `${viewport.width}x${viewport.height} CSS px at ${viewport.deviceScaleFactor}x`,
    colorScheme: typeof manifest.colorScheme === 'string' ? manifest.colorScheme : 'light',
    query: manifest.query,
    images,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fence(lang, body) {
  return `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``
}

function renderScreenshots(s) {
  const images = s.images
    .map((image) => {
      const source =
        image.ref === BUG_REF
          ? `\`${BUG_REF}\` (\`${image.commit.slice(0, 7)}\`)`
          : `\`HEAD\` at capture time (\`${image.commit.slice(0, 7)}\`), whose non-test \`src/\` is identical to \`${FIX_REF}\``
      const rows = `${image.visibleTasks} task row${image.visibleTasks === 1 ? '' : 's'}`
      return `### ${image.title}

![${image.alt}](${path.posix.relative('case', image.file)})

${image.caption}

Page state read by the script: summary "${image.summary}", ${rows}; source: ${source}.`
    })
    .join('\n\n')

  return `## Screenshots

Captured by \`npm run case:screenshots\` (scripts/capture-screenshots.mjs) on ${s.capturedAt} with ${s.browser}
running headless, viewport ${s.viewport}, ${s.colorScheme} colour scheme. The script writes the \`${BUG_REF}\`
version of the changed source file into the working tree the same way the proof does, drives this repo's dev
server over the Chrome DevTools protocol, clicks the search box and types "${s.query}" key by key, reads the
summary line and the task rows back from the DOM, and refuses to capture when they differ from what is
described here. It then restores the file and repeats the typing on the fixed code. Each "Page state" line
quotes what it read at the moment of the capture. The images are unedited captures of the app area
(\`main.app\`) in this repository, not mock-ups.

${images}`
}

function renderScreenshotInstructions() {
  return `## Screenshot instructions (no screenshots are included yet)

This write-up was generated without screenshots. To add honest before/after captures, run
\`npm run case:screenshots\` (it drives a locally installed Chrome or Edge headless and downloads nothing;
see the README). It writes \`case/screenshots/before-typed.png\`, \`before-after-toggle.png\`,
\`after-typed.png\` and \`manifest.json\`. Then list the images under \`screenshots\` in
\`scripts/case-content.mjs\` and rerun \`npm run case:build\`. Do not present them as anything other than
captures of this demo app.`
}

function renderCaseStudy(c, extras) {
  const steps = c.reproSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  const stackList = c.stack.map((s) => `- ${s}`).join('\n')
  const changedFiles = extras.files.map((f) => `\`${f.path}\``).join(', ')
  const headDrifted = c.headMatchesFixTag === false
  const driftNote = headDrifted
    ? `
> **Note: generated with \`${ALLOW_HEAD_DRIFT_FLAG}\`.** When this write-up was built, the non-test
> files under \`src/\` at \`HEAD\` differed from the \`${FIX_REF}\` tag. The diff below is between the
> two tags, while the "After" test run was measured on \`HEAD\`, so the two may not describe exactly
> the same code. \`case.json\` records this as \`"headMatchesFixTag": false\`.
`
    : ''

  return `# ${c.title}

> **${c.label}.** The bug in this repository was introduced on purpose to build a
> reproducible before/after example. It is not taken from anyone's codebase, and no
> client was involved. Everything below was measured in this repository by
> \`npm run case:build\` on ${c.generatedAt}.
${driftNote}
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
and the second passes, judged from Vitest's own report (failed tests counted, test files that
failed to load rejected), not from the exit code alone. Local paths are shown as \`<repo>\`;
timings are replaced by \`<time>\`, \`<elapsed>\` and \`<n>ms\` so reruns are reproducible; long
output is trimmed where marked.

### Before: tests run against the \`${BUG_REF}\` source

${fence('text', c.testOutputBefore)}

### After: tests run on ${headDrifted ? `\`HEAD\` (which differs from \`${FIX_REF}\`, see the note at the top)` : `\`${FIX_REF}\``}

${fence('text', c.testOutputAfter)}

### The warning that was already there

ESLint output for the \`${BUG_REF}\` version of the changed file (rule \`react-hooks/exhaustive-deps\`,
configured at its default level, "warn"):

${fence('text', extras.lintBefore || '(not captured)')}

## Lesson

${c.lesson}

${c.screenshots ? renderScreenshots(c.screenshots) : renderScreenshotInstructions()}

## Commits

- \`${c.commits.bug.hash}\` ${c.commits.bug.message}
- \`${c.commits.fix.hash}\` ${c.commits.fix.message}

Note for the publisher: rewriting authorship before publishing (see README) changes these hashes;
rerun \`npm run case:screenshots\` and \`npm run case:build\` afterwards so this file, \`case.json\` and the
screenshots' manifest match the published history.
`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== ALLOW_HEAD_DRIFT_FLAG)
  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(' ')}. The only option is ${ALLOW_HEAD_DRIFT_FLAG}.`)
  }
  return { allowHeadDrift: argv.includes(ALLOW_HEAD_DRIFT_FLAG) }
}

function main() {
  const { allowHeadDrift } = parseArgs(process.argv.slice(2))

  const proof = proveRegression()
  if (!proof.ok) {
    console.error('\nbuild-case: the regression proof did not hold; case files were NOT written.')
    process.exitCode = 1
    return
  }

  if (!proof.headMatchesFixTag && !allowHeadDrift) {
    console.error(
      `\nbuild-case: the non-test files under src/ at HEAD differ from the ${FIX_REF} tag, so the diff ` +
        `(${BUG_REF}..${FIX_REF}) and the "after" test run (measured on HEAD) would describe different code. ` +
        'Case files were NOT written.\n' +
        `  Either re-point ${FIX_REF} at the commit that holds the current src/ (see README, "Before publishing"),\n` +
        `  or rerun with:  npm run case:build -- ${ALLOW_HEAD_DRIFT_FLAG}\n` +
        '  to write the case anyway with "headMatchesFixTag": false in case.json and a visible note in CASE_STUDY.md.',
    )
    process.exitCode = 1
    return
  }

  // Sanity checks on what we are about to publish, taken from the parsed
  // Vitest reports (the same numbers prove-regression judged the runs by).
  const { before, after } = proof
  if (before.outcome !== 'failed' || !before.report || before.report.failedTests < 1 || before.report.suiteErrors.length > 0) {
    throw new Error(
      `Expected the "before" run to have at least one failed test and no test file that failed to load; ` +
        `got ${describeRun(before)}. Refusing to write case files.`,
    )
  }
  if (after.outcome !== 'passed' || !after.report || after.report.failedTests !== 0 || after.report.passedTests < 1) {
    throw new Error(`Expected the "after" run to have only passing tests; got ${describeRun(after)}. Refusing to write case files.`)
  }

  const testOutputBefore = trimOutput(before.output)
  const testOutputAfter = trimOutput(after.output)

  // The trimmed text must still show the summary line those counts came from.
  if (!testOutputBefore.includes(`${before.report.failedTests} failed`)) {
    throw new Error('The trimmed "before" output no longer shows the failed-test count from the Vitest report; refusing to write case files.')
  }
  if (!testOutputAfter.includes(`${after.report.passedTests} passed`)) {
    throw new Error('The trimmed "after" output no longer shows the passed-test count from the Vitest report; refusing to write case files.')
  }

  const testFileTracked = git(['ls-files', '--error-unmatch', caseContent.testFile], { allowFailure: true })
  if (testFileTracked.status !== 0) {
    throw new Error(`Regression test ${caseContent.testFile} is not tracked by git.`)
  }

  const screenshots = screenshotFacts(caseContent.screenshots)

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
    // A date, not a timestamp, so a rerun on the same history is byte-identical.
    generatedAt: new Date().toISOString().slice(0, 10),
  }
  // Only present when the case was knowingly written with HEAD drift; the
  // website's sync script ignores unknown fields with a warning.
  if (!proof.headMatchesFixTag) caseJson.headMatchesFixTag = false
  // Only present when case-content.mjs lists screenshots (see screenshotFacts).
  if (screenshots) caseJson.screenshots = screenshots

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
  if (!proof.headMatchesFixTag) {
    console.log(`Written with ${ALLOW_HEAD_DRIFT_FLAG}: HEAD's src/ differs from ${FIX_REF}; the study carries a note.`)
  }
}

try {
  main()
} catch (error) {
  console.error(`\nbuild-case: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
