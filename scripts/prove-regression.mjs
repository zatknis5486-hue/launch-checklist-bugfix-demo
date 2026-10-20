#!/usr/bin/env node
/**
 * Regression proof for the Launch Checklist demo.
 *
 * What it does:
 *   1. Lists the non-test files under src/ that differ between the `demo-bug`
 *      and `demo-fix` tags.
 *   2. Temporarily writes the `demo-bug` version of those files into the
 *      working tree and runs the test suite that lives at HEAD against them.
 *      Expected: the regression tests FAIL.
 *   3. Restores the files with `git checkout --` (on completion or error, in a
 *      finally block) and runs the suite again on HEAD. Expected: PASS.
 *   4. Exits 0 only if run 1 failed AND run 2 passed. Anything else exits 1
 *      with an explanation.
 *
 * How a run is judged: not by the exit code alone. Vitest also writes a JSON
 * report (case/.tmp/, gitignored) and the script reads it back. Run 1 counts
 * as FAILED only if at least one test failed and no test file failed to load;
 * run 2 counts as PASSED only if every collected test passed. A crash, an
 * import error, a timeout, a signal or a missing report is an ERROR, and an
 * ERROR never counts as proof.
 *
 * Safety: it refuses to start if any file it would touch has uncommitted
 * changes, so it never destroys work in progress. It never restores anything
 * on start either; if an earlier run was interrupted in a way no finally block
 * survives, the refusal message prints the exact `git checkout --` command.
 *
 * Usage:
 *   node scripts/prove-regression.mjs
 *   # git not on PATH (e.g. a portable git on Windows):
 *   GIT_EXE=C:\path\to\git.exe node scripts/prove-regression.mjs
 *
 * No dependencies beyond Node built-ins. Also importable: build-case.mjs
 * reuses proveRegression() to capture both test runs.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BUG_REF = process.env.DEMO_BUG_REF || 'demo-bug'
export const FIX_REF = process.env.DEMO_FIX_REF || 'demo-fix'

/**
 * Pathspec for "src/ without the test files". Shared with build-case.mjs so
 * the drift check below and the published diff cover the same files.
 * ":(exclude)" needs a git with pathspec magic (verified with 2.56).
 */
export const SOURCE_PATHSPEC = ['src', ':(exclude)*.test.ts', ':(exclude)*.test.tsx']

const GIT = process.env.GIT_EXE || 'git'
const TEST_FILE_PATTERN = /\.test\.tsx?$/
const VITEST_TIMEOUT_MS = 10 * 60_000
/** Where Vitest's JSON reports go. Listed in .gitignore and the ESLint ignores. */
const REPORT_DIR = path.join(repoRoot, 'case', '.tmp')

/** Run git in the repo root. Throws on non-zero exit unless allowFailure. */
export function git(args, { allowFailure = false, binary = false } = {}) {
  const result = spawnSync(GIT, args, {
    cwd: repoRoot,
    encoding: binary ? 'buffer' : 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(
      `Could not run "${GIT}": ${result.error.message}\n` +
        'If git is not on PATH, set the GIT_EXE environment variable to the full path of git.exe.',
    )
  }
  if (result.status !== 0 && !allowFailure) {
    const stderr = binary ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`git ${args.join(' ')} exited with code ${result.status}:\n${stderr}`)
  }
  return result
}

/**
 * Read the JSON report Vitest wrote for one run and reduce it to the numbers
 * the proof needs. Returns null when the file is missing, unparseable or not
 * shaped like a Vitest report, so a run without a report is never mistaken
 * for a run with zero failures.
 */
function readVitestReport(reportFile) {
  let raw
  try {
    raw = JSON.parse(readFileSync(reportFile, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.testResults)) return null
  for (const key of ['numTotalTests', 'numPassedTests', 'numFailedTests']) {
    if (typeof raw[key] !== 'number') return null
  }
  const files = raw.testResults.map((file) => {
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : []
    const name = typeof file.name === 'string' ? file.name : ''
    return {
      file: name ? path.relative(repoRoot, name).replace(/\\/g, '/') : '(unnamed file)',
      status: file.status,
      failedTests: assertions.filter((a) => a.status === 'failed').length,
      message: typeof file.message === 'string' ? file.message : '',
    }
  })
  // A test file marked failed without a single failed test never got as far as
  // running its tests: an import or transform error, a crashed worker, a
  // broken hook. Vitest reports these with an empty assertion list and the
  // error in `message`, and they leave numFailedTests at 0.
  const suiteErrors = files
    .filter((f) => f.status === 'failed' && f.failedTests === 0)
    .map((f) => ({ file: f.file, message: f.message.split('\n')[0] || '(no error message)' }))
  return {
    totalTests: raw.numTotalTests,
    passedTests: raw.numPassedTests,
    failedTests: raw.numFailedTests,
    skippedTests: (typeof raw.numPendingTests === 'number' ? raw.numPendingTests : 0) +
      (typeof raw.numTodoTests === 'number' ? raw.numTodoTests : 0),
    fileCount: files.length,
    suiteErrors,
  }
}

/**
 * Decide what one run shows. Only 'failed' (tests ran and some failed) and
 * 'passed' (tests ran and all passed) can take part in a proof; everything
 * else is 'error' with a reason.
 */
function judgeRun(status, report) {
  if (status === null) {
    return { outcome: 'error', reason: 'Vitest was ended by a signal before it finished, so there is no exit code' }
  }
  if (!report) {
    return {
      outcome: 'error',
      reason: `exit ${status}, but Vitest wrote no readable JSON report: it crashed or never started`,
    }
  }
  if (report.suiteErrors.length > 0) {
    const list = report.suiteErrors.map((e) => `${e.file}: ${e.message}`).join('; ')
    return {
      outcome: 'error',
      reason: `${report.suiteErrors.length} test file(s) failed to load instead of running: ${list}`,
    }
  }
  if (report.totalTests === 0) {
    return { outcome: 'error', reason: 'no tests were collected' }
  }
  if (report.failedTests > 0) {
    if (status === 0) {
      return { outcome: 'error', reason: `${report.failedTests} test(s) failed but Vitest exited 0; report and exit code disagree` }
    }
    return { outcome: 'failed', reason: '' }
  }
  if (status !== 0) {
    return {
      outcome: 'error',
      reason: `exit ${status} without a single failed test: an unhandled error, a crash or an environment failure, not a test result`,
    }
  }
  if (report.passedTests === 0) {
    return { outcome: 'error', reason: 'no test passed (all skipped?)' }
  }
  return { outcome: 'passed', reason: '' }
}

/** One line describing a run, for the verdict and for build-case's checks. */
export function describeRun(run) {
  const r = run.report
  const counts = r
    ? `${r.failedTests} failed, ${r.passedTests} passed` +
      (r.skippedTests ? `, ${r.skippedTests} skipped` : '') +
      ` of ${r.totalTests} tests in ${r.fileCount} files`
    : 'no report'
  if (run.outcome === 'failed') return `FAILED (exit ${run.status}; ${counts}; every test file loaded)`
  if (run.outcome === 'passed') return `PASSED (exit ${run.status}; ${counts})`
  return `ERROR (${run.reason})`
}

/**
 * Run the Vitest CLI once and capture its combined, colour-free output.
 * Returns { status, output, report, outcome, reason, passed, failed }:
 * `output` is the default reporter's text, `report` the parsed JSON report
 * (or null) and `outcome` one of 'passed' | 'failed' | 'error' (see judgeRun).
 * `label` names the JSON report file under case/.tmp.
 */
export function runVitest(label = 'run') {
  const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitestBin)) {
    throw new Error(`Vitest not found at ${vitestBin}. Run "npm install" first.`)
  }
  mkdirSync(REPORT_DIR, { recursive: true })
  const reportFile = path.join(REPORT_DIR, `vitest-${label}.json`)
  rmSync(reportFile, { force: true }) // never judge this run by a stale report

  const result = spawnSync(
    process.execPath,
    [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      // A hung Vitest must become an error that reaches the caller's finally
      // block (which restores the source files), not a process that only
      // Ctrl+C can end, because Ctrl+C would skip that finally block.
      timeout: VITEST_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  )
  if (result.error) {
    const why =
      result.error.code === 'ETIMEDOUT'
        ? `it did not finish within ${VITEST_TIMEOUT_MS / 60_000} minutes and was killed`
        : result.error.message
    throw new Error(`Could not run Vitest: ${why}`)
  }
  const output = stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    // The JSON reporter announces its file on stdout; that is bookkeeping, not evidence.
    .replace(/\n?^JSON report written to .*(?:\r?\n|$)/gm, '')
  const report = readVitestReport(reportFile)
  const { outcome, reason } = judgeRun(result.status, report)
  return {
    status: result.status,
    output,
    report,
    outcome,
    reason,
    passed: outcome === 'passed',
    failed: outcome === 'failed',
  }
}

function ensureRef(ref) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })
  if (result.status !== 0) {
    throw new Error(`Git ref "${ref}" does not exist in this repository. Expected tags: ${BUG_REF} and ${FIX_REF}.`)
  }
  return result.stdout.trim()
}

/**
 * Non-test files under src/ that differ between the two refs.
 * Returns [{ status: 'M' | 'A', path }]. Other change types are rejected
 * because this script cannot emulate them safely in place.
 */
export function changedSourceFiles() {
  const out = git(['diff', '--name-status', BUG_REF, FIX_REF, '--', 'src']).stdout
  const files = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const status = parts[0][0]
    const filePath = parts[parts.length - 1]
    if (TEST_FILE_PATTERN.test(filePath)) continue
    if (status === 'M' || status === 'A') {
      files.push({ status, path: filePath })
    } else {
      throw new Error(
        `Change type "${parts[0]}" for ${filePath} is not supported by this script ` +
          '(only modified or added files can be reverted in place).',
      )
    }
  }
  return files
}

/** The exact command that puts the HEAD version of `paths` back. */
function checkoutCommand(paths) {
  return `git checkout -- ${paths.join(' ')}`
}

function ensureClean(paths) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
  if (dirty) {
    throw new Error(
      'Refusing to run: the following files have uncommitted changes and would be overwritten.\n' +
        `${dirty}\n` +
        'Commit or stash them first.\n' +
        `If a previous proof run was interrupted, discard the leftover bug version with: ${checkoutCommand(paths)}`,
    )
  }
}

/**
 * True when the non-test files under src/ at HEAD are identical to FIX_REF.
 * When false, run 2 (and build-case's "after" output) measures code the
 * published demo-bug..demo-fix diff does not show.
 */
function headMatchesFix() {
  const result = git(['diff', '--quiet', FIX_REF, 'HEAD', '--', ...SOURCE_PATHSPEC], { allowFailure: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`git diff --quiet ${FIX_REF} HEAD exited with code ${result.status}:\n${result.stderr}`)
}

function banner(title) {
  const line = '='.repeat(72)
  return `\n${line}\n ${title}\n${line}`
}

/**
 * Runs the whole proof. Returns
 * { files, before, after, ok, verdict, headMatchesFixTag }, where `before`
 * and `after` are runVitest() results.
 * `log` receives progress lines (defaults to console.log).
 */
export function proveRegression({ log = console.log } = {}) {
  ensureRef(BUG_REF)
  ensureRef(FIX_REF)

  const files = changedSourceFiles()
  if (files.length === 0) {
    throw new Error(`No non-test files under src/ differ between ${BUG_REF} and ${FIX_REF}; nothing to prove.`)
  }
  const paths = files.map((f) => f.path)
  ensureClean(paths)

  const headMatchesFixTag = headMatchesFix()
  if (!headMatchesFixTag) {
    log(`Note: the non-test files under src/ at HEAD differ from ${FIX_REF}; run 2 reflects HEAD, not the tag.`)
  }

  log(banner(`RUN 1: tests from HEAD against the ${BUG_REF} version of:`))
  for (const f of files) log(`   ${f.status}  ${f.path}`)

  let before
  let restoreError = null
  try {
    for (const f of files) {
      const absolute = path.join(repoRoot, f.path)
      if (f.status === 'M') {
        const content = git(['show', `${BUG_REF}:${f.path}`], { binary: true }).stdout
        writeFileSync(absolute, content)
      } else {
        // Added in the fix: it did not exist in the bug version.
        unlinkSync(absolute)
      }
    }
    before = runVitest('before')
    log(before.output.trimEnd())
  } finally {
    try {
      git(['checkout', '--', ...paths])
      const stillDirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
      if (stillDirty) {
        restoreError = new Error(`Files were restored but the working tree is still dirty:\n${stillDirty}`)
        console.error(restoreWarning(paths, restoreError))
      }
    } catch (error) {
      // Say it now: if the try block above threw as well, that exception is
      // the one that propagates and restoreError would never be shown.
      console.error(restoreWarning(paths, error))
      restoreError = error
    }
  }
  if (restoreError) throw restoreError

  log(banner(`RUN 2: tests on HEAD (${FIX_REF} applied)`))
  const after = runVitest('after')
  log(after.output.trimEnd())

  const ok = before.failed && after.passed
  const verdictLines = [
    `Run 1 (${BUG_REF} source): ${describeRun(before)}  expected: FAILED`,
    `Run 2 (HEAD):             ${describeRun(after)}  expected: PASSED`,
  ]
  if (ok) {
    verdictLines.push('Regression proven: the tests catch the bug and pass with the fix.')
  } else if (before.outcome === 'error' || after.outcome === 'error') {
    verdictLines.push(
      'NOT proven: at least one run did not produce a trustworthy test result (see ERROR above). ' +
        'A crash or a test file that failed to load is not a failing or passing suite.',
    )
  } else if (before.passed && after.passed) {
    verdictLines.push('NOT proven: the tests also pass against the bug version, so they do not cover the regression.')
  } else if (before.failed && after.failed) {
    verdictLines.push('NOT proven: the tests fail on HEAD too; fix the suite or the code first.')
  } else {
    verdictLines.push('NOT proven: the tests fail on HEAD but pass against the bug version; something is inverted.')
  }
  if (!headMatchesFixTag) {
    verdictLines.push(`Note: HEAD's non-test src/ differs from ${FIX_REF}; run 2 measured HEAD.`)
  }
  const verdict = verdictLines.join('\n')

  log(banner('VERDICT'))
  log(verdict)

  return { files, before, after, ok, verdict, headMatchesFixTag }
}

function restoreWarning(paths, error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    '\nprove-regression: COULD NOT RESTORE the working tree. These files may still hold the ' +
    `${BUG_REF} version:\n` +
    paths.map((p) => `   ${p}`).join('\n') +
    '\nPut the committed version back by hand with:\n' +
    `   ${checkoutCommand(paths)}\n` +
    `Cause: ${message}`
  )
}

function isMainModule() {
  if (!process.argv[1]) return false
  const argvUrl = pathToFileURL(path.resolve(process.argv[1])).href
  const own = import.meta.url
  return process.platform === 'win32' ? argvUrl.toLowerCase() === own.toLowerCase() : argvUrl === own
}

if (isMainModule()) {
  try {
    const result = proveRegression()
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    console.error(`\nprove-regression: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
