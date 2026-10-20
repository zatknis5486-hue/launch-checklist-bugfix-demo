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
 *   3. Restores the files with `git checkout --` (always, in a finally block)
 *      and runs the suite again on HEAD. Expected: PASS.
 *   4. Exits 0 only if run 1 failed AND run 2 passed. Anything else exits 1
 *      with an explanation.
 *
 * Safety: it refuses to start if any file it would touch has uncommitted
 * changes, so it never destroys work in progress.
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
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BUG_REF = process.env.DEMO_BUG_REF || 'demo-bug'
export const FIX_REF = process.env.DEMO_FIX_REF || 'demo-fix'

const GIT = process.env.GIT_EXE || 'git'
const TEST_FILE_PATTERN = /\.test\.tsx?$/

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

/** Run the Vitest CLI once and capture its combined, colour-free output. */
export function runVitest() {
  const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitestBin)) {
    throw new Error(`Vitest not found at ${vitestBin}. Run "npm install" first.`)
  }
  const result = spawnSync(process.execPath, [vitestBin, 'run', '--reporter=default'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`Could not run Vitest: ${result.error.message}`)
  }
  const output = stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  return { status: result.status, passed: result.status === 0, output }
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

function ensureClean(paths) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
  if (dirty) {
    throw new Error(
      'Refusing to run: the following files have uncommitted changes and would be overwritten.\n' +
        `${dirty}\n` +
        'Commit or stash them first.',
    )
  }
}

function banner(title) {
  const line = '='.repeat(72)
  return `\n${line}\n ${title}\n${line}`
}

/**
 * Runs the whole proof. Returns
 * { files, before: {status, passed, output}, after: {...}, ok, verdict }.
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

  const headDiffersFromFix =
    git(['diff', '--quiet', FIX_REF, 'HEAD', '--', ...paths], { allowFailure: true }).status !== 0
  if (headDiffersFromFix) {
    log(`Note: HEAD differs from ${FIX_REF} in the files under test; run 2 reflects HEAD, not the tag.`)
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
    before = runVitest()
    log(before.output.trimEnd())
  } finally {
    try {
      git(['checkout', '--', ...paths])
      const stillDirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
      if (stillDirty) {
        restoreError = new Error(`Files were restored but the working tree is still dirty:\n${stillDirty}`)
      }
    } catch (error) {
      restoreError = error
    }
  }
  if (restoreError) throw restoreError

  log(banner(`RUN 2: tests on HEAD (${FIX_REF} applied)`))
  const after = runVitest()
  log(after.output.trimEnd())

  const ok = !before.passed && after.passed
  const verdictLines = [
    `Run 1 (${BUG_REF} source): ${before.passed ? 'PASSED' : 'FAILED'} (exit ${before.status})  expected: FAILED`,
    `Run 2 (HEAD):             ${after.passed ? 'PASSED' : 'FAILED'} (exit ${after.status})  expected: PASSED`,
  ]
  if (ok) {
    verdictLines.push('Regression proven: the tests catch the bug and pass with the fix.')
  } else if (before.passed && after.passed) {
    verdictLines.push('NOT proven: the tests also pass against the bug version, so they do not cover the regression.')
  } else if (!before.passed && !after.passed) {
    verdictLines.push('NOT proven: the tests fail on HEAD too; fix the suite or the code first.')
  } else {
    verdictLines.push('NOT proven: the tests fail on HEAD but pass against the bug version; something is inverted.')
  }
  const verdict = verdictLines.join('\n')

  log(banner('VERDICT'))
  log(verdict)

  return { files, before, after, ok, verdict }
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
