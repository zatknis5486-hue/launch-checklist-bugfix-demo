#!/usr/bin/env node
/**
 * Captures the before/after screenshots shown in case/CASE_STUDY.md.
 *
 * What it does:
 *   1. Like prove-regression.mjs, temporarily writes the `demo-bug` version of
 *      the non-test files under src/ that the fix changed into the working
 *      tree. It refuses to start if any of them has uncommitted changes and
 *      restores them with `git checkout --` in a finally block.
 *   2. Starts this repo's Vite dev server on a free port and a locally
 *      installed Chrome or Edge in headless mode, driven over the Chrome
 *      DevTools protocol with Node built-ins only (WebSocket, fetch). Nothing
 *      is downloaded: no browser binary, no extra npm package.
 *   3. Clicks the search box, types "redirect" key by key, reads the summary
 *      line and the task list back from the DOM and captures the app area.
 *      Then ticks the checkbox of the one task that matches and captures again
 *      (the stale filter suddenly applies). It refuses to write an image whose
 *      page state is not exactly the one the write-up describes.
 *   4. Restores src/, repeats the typing on HEAD (the fixed code) and captures
 *      the result.
 *   5. Writes case/screenshots/manifest.json: browser version, viewport, the
 *      commit each image was taken from and the text read from the page.
 *      build-case.mjs merges that into case.json and the study, so what the
 *      write-up says about each image is what the script observed.
 *
 * Output: case/screenshots/before-typed.png, before-after-toggle.png,
 * after-typed.png and manifest.json. Commit them together with the regenerated
 * case files (`npm run case:build`).
 *
 * Usage:
 *   npm run case:screenshots
 *   # browser somewhere unusual, or git not on PATH:
 *   CHROME_EXE=/path/to/chrome GIT_EXE=/path/to/git npm run case:screenshots
 *
 * No dependencies beyond Node built-ins and this repo's own devDependencies
 * (Vite). Requires Node 22+ for the global WebSocket.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUG_REF, changedSourceFiles, git, repoRoot } from './prove-regression.mjs'

export const SCREENSHOT_DIR = path.join(repoRoot, 'case', 'screenshots')
export const MANIFEST_FILE = path.join(SCREENSHOT_DIR, 'manifest.json')

/** CSS pixels; the images are deviceScaleFactor times larger. */
export const VIEWPORT = { width: 1024, height: 900, deviceScaleFactor: 2 }
const COLOR_SCHEME = 'light'
const QUERY = 'redirect'
const MATCHING_TITLE = 'Configure Supabase auth redirect URL for the production domain'
const STEP_TIMEOUT_MS = 60_000
/** The app's bottom padding is 64px; keep 32px so top and bottom match. */
const BOTTOM_TRIM_PX = 32

/**
 * What each image must show, checked against the DOM right before the
 * capture. `visibleCount` is the number of rendered task rows; `checked` the
 * titles of the ticked rows (all three seeded "done" tasks, plus the one the
 * script ticks itself). Session 1 runs against the demo-bug source, session 2
 * against HEAD.
 */
const SESSIONS = [
  {
    ref: BUG_REF,
    label: `the ${BUG_REF} version of src/`,
    steps: [
      { do: 'type', text: QUERY },
      {
        do: 'capture',
        file: 'before-typed.png',
        expect: { search: QUERY, summary: 'Showing 9 of 9 tasks (6 open)', visibleCount: 9, checkedCount: 3 },
      },
      { do: 'toggle', title: MATCHING_TITLE },
      {
        do: 'capture',
        file: 'before-after-toggle.png',
        expect: { search: QUERY, summary: 'Showing 1 of 9 tasks (5 open)', visibleCount: 1, checkedCount: 1, visible: [MATCHING_TITLE] },
      },
    ],
  },
  {
    ref: 'HEAD',
    label: 'HEAD',
    steps: [
      { do: 'type', text: QUERY },
      {
        do: 'capture',
        file: 'after-typed.png',
        expect: { search: QUERY, summary: 'Showing 1 of 9 tasks (6 open)', visibleCount: 1, checkedCount: 0, visible: [MATCHING_TITLE] },
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// PNG header (shared with build-case.mjs)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width and height from a PNG's IHDR chunk. Throws if `buffer` is not a PNG. */
export function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** A locally installed Chrome or Edge. Never downloads anything. */
export function findBrowser() {
  const fromEnv = process.env.CHROME_EXE
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_EXE points at ${fromEnv}, which does not exist.`)
    return fromEnv
  }
  const candidates = []
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const which = spawnSync('which', [name], { encoding: 'utf8' })
      if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim())
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      'No Chrome or Edge found in the usual locations. Install one, or set CHROME_EXE to the browser executable. ' +
        'This script never downloads a browser.',
    )
  }
  return found
}

/** Start the browser headless with a throwaway profile; resolve once DevTools is reachable. */
async function launchBrowser(executable, profileDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--hide-scrollbars',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr.setEncoding('utf8')
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('The browser did not announce its DevTools endpoint within 30 s.')), 30_000)
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`The browser exited with code ${code} before DevTools was ready.\n${buffer}`))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Could not start ${executable}: ${error.message}`))
    })
  })
  const httpBase = endpoint.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1')
  const version = await (await fetch(`${httpBase}/json/version`)).json()
  const targets = await (await fetch(`${httpBase}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('The headless browser opened no page target.')
  return { child, pageWsUrl: page.webSocketDebuggerUrl, browser: version.Browser, userAgent: version['User-Agent'] }
}

/** Minimal Chrome DevTools protocol client over the global WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
      }
    })
    ws.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error(`${entry.method}: the DevTools connection closed`))
      this.pending.clear()
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Cdp(ws)))
      ws.addEventListener('error', () => reject(new Error(`Could not open the DevTools WebSocket at ${url}`)))
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { method, resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((fn) => fn !== listener))
        resolve(params)
      }
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener])
    })
  }

  close() {
    this.ws.close()
  }
}

// ---------------------------------------------------------------------------
// Page driving
// ---------------------------------------------------------------------------

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) {
    throw new Error(`Script in the page failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  }
  return result.value
}

/** Everything the expectations are checked against, read from the live DOM. */
const READ_STATE = `(() => {
  const rows = [...document.querySelectorAll('.task')]
  const title = (row) => row.querySelector('.task-title').textContent.trim()
  const summary = document.querySelector('.summary')
  const search = document.getElementById('task-search')
  return {
    summary: summary ? summary.textContent.trim() : null,
    search: search ? search.value : null,
    visible: rows.map(title),
    checked: rows.filter((row) => row.querySelector('input[type=checkbox]').checked).map(title),
  }
})()`

function readState(cdp) {
  return evaluate(cdp, READ_STATE)
}

async function waitFor(cdp, description, predicate) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await readState(cdp)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}. Last page state: ${JSON.stringify(last)}`)
}

/** Centre of an element, in CSS pixels, for a real mouse click. */
async function centreOf(cdp, selectorExpression) {
  const point = await evaluate(
    cdp,
    `(() => { const el = ${selectorExpression}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
  )
  if (!point) throw new Error(`Element not found in the page: ${selectorExpression}`)
  return point
}

async function click(cdp, { x, y }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** Key by key, like a person typing: keyDown carries the character, then keyUp. */
async function typeText(cdp, text) {
  for (const char of text) {
    const upper = char.toUpperCase()
    const key = {
      key: char,
      code: /^[a-z]$/i.test(char) ? `Key${upper}` : undefined,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      nativeVirtualKeyCode: upper.charCodeAt(0),
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, unmodifiedText: char, ...key })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
}

function checkExpectation(file, expect, state) {
  const problems = []
  if (state.search !== expect.search) problems.push(`search box holds ${JSON.stringify(state.search)}, expected ${JSON.stringify(expect.search)}`)
  if (state.summary !== expect.summary) problems.push(`summary reads ${JSON.stringify(state.summary)}, expected ${JSON.stringify(expect.summary)}`)
  if (state.visible.length !== expect.visibleCount) problems.push(`${state.visible.length} task rows rendered, expected ${expect.visibleCount}`)
  if (state.checked.length !== expect.checkedCount) problems.push(`${state.checked.length} rows ticked, expected ${expect.checkedCount}`)
  if (expect.visible && JSON.stringify(state.visible) !== JSON.stringify(expect.visible)) {
    problems.push(`visible rows are ${JSON.stringify(state.visible)}, expected ${JSON.stringify(expect.visible)}`)
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to capture ${file}: the page is not in the expected state.\n  - ${problems.join('\n  - ')}`)
  }
}

/** Screenshot of the app area (the centred <main class="app">), top padding kept, bottom trimmed to match. */
async function captureApp(cdp, outFile) {
  const rect = await evaluate(
    cdp,
    `(() => { const r = document.querySelector('main.app').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, pageHeight: document.documentElement.scrollHeight } })()`,
  )
  // Make the viewport at least as tall as the page so no scrollbar or fold interferes.
  const height = Math.max(VIEWPORT.height, Math.ceil(rect.pageHeight))
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, height, mobile: false })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const clip = {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height - BOTTOM_TRIM_PX),
    scale: 1,
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  const buffer = Buffer.from(data, 'base64')
  const size = readPngSize(buffer)
  writeFileSync(outFile, buffer)
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false })
  return size
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function startDevServer() {
  // Imported lazily so build-case.mjs can import readPngSize from this file
  // without loading Vite.
  const { createServer } = await import('vite')
  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address !== 'object') throw new Error('The Vite dev server did not report a port.')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

async function runSession(session, { browser, log }) {
  const { server, url } = await startDevServer()
  const cdp = await Cdp.connect(browser.pageWsUrl)
  const results = {}
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false })
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: COLOR_SCHEME }] })

    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    await waitFor(cdp, 'the app to render its 9 seeded tasks', (state) => state.visible.length === 9 && state.summary !== null)

    for (const step of session.steps) {
      if (step.do === 'type') {
        await click(cdp, await centreOf(cdp, "document.getElementById('task-search')"))
        await typeText(cdp, step.text)
        await waitFor(cdp, `the search box to hold ${JSON.stringify(step.text)}`, (state) => state.search === step.text)
        log(`   typed ${JSON.stringify(step.text)} into the search box`)
      } else if (step.do === 'toggle') {
        const checkbox = `[...document.querySelectorAll('.task')].find((row) => row.querySelector('.task-title').textContent.trim() === ${JSON.stringify(step.title)})?.querySelector('input[type=checkbox]')`
        await click(cdp, await centreOf(cdp, checkbox))
        await waitFor(cdp, `the checkbox of ${JSON.stringify(step.title)} to be ticked`, (state) => state.checked.includes(step.title))
        log(`   ticked the checkbox of ${JSON.stringify(step.title)}`)
      } else if (step.do === 'capture') {
        // Give React one more frame after the last input before reading the state.
        await evaluate(cdp, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const state = await readState(cdp)
        checkExpectation(step.file, step.expect, state)
        const outFile = path.join(SCREENSHOT_DIR, step.file)
        const size = await captureApp(cdp, outFile)
        results[step.file] = { ...size, observed: state }
        log(`   wrote case/screenshots/${step.file} (${size.width}x${size.height}px): ${state.summary}`)
      } else {
        throw new Error(`Unknown step ${JSON.stringify(step)}`)
      }
    }
  } finally {
    cdp.close()
    await server.close()
  }
  return results
}

function ensureClean(paths) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
  if (dirty) {
    throw new Error(
      'Refusing to run: the following files have uncommitted changes and would be overwritten.\n' +
        `${dirty}\n` +
        `Commit or stash them first. To discard a leftover ${BUG_REF} version: git checkout -- ${paths.join(' ')}`,
    )
  }
}

export async function captureScreenshots({ log = console.log } = {}) {
  const files = changedSourceFiles()
  if (files.length === 0) throw new Error(`No non-test files under src/ differ between ${BUG_REF} and the fix; nothing to show.`)
  const paths = files.map((file) => file.path)
  ensureClean(paths)
  const headHash = git(['rev-parse', 'HEAD']).stdout.trim()
  const bugHash = git(['rev-parse', `${BUG_REF}^{commit}`]).stdout.trim()

  const executable = findBrowser()
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'launch-checklist-shots-'))
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  log(`Browser: ${executable}`)

  const browser = await launchBrowser(executable, profileDir)
  log(`Connected to ${browser.browser} (headless) over the DevTools protocol`)
  const shots = {}
  try {
    for (const session of SESSIONS) {
      const usesBugSource = session.ref === BUG_REF
      log(`\nSession: ${session.label}`)
      if (usesBugSource) {
        for (const file of files) {
          const absolute = path.join(repoRoot, file.path)
          if (file.status === 'M') {
            writeFileSync(absolute, git(['show', `${BUG_REF}:${file.path}`], { binary: true }).stdout)
          } else {
            rmSync(absolute, { force: true })
          }
          log(`   ${file.status}  ${file.path} <- ${BUG_REF}`)
        }
      }
      let results
      let restoreError = null
      try {
        results = await runSession(session, { browser, log })
      } finally {
        if (usesBugSource) {
          try {
            git(['checkout', '--', ...paths])
            const stillDirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trim()
            if (stillDirty) {
              restoreError = new Error(`Restored ${paths.join(', ')} but the working tree is still dirty:\n${stillDirty}`)
            } else {
              log(`   restored ${paths.join(', ')} from HEAD`)
            }
          } catch (error) {
            restoreError = error
          }
          if (restoreError) {
            // Say it now: if runSession threw as well, that error is the one
            // that propagates, and the tree may still hold the bug version.
            console.error(
              `\ncapture-screenshots: COULD NOT RESTORE ${paths.join(', ')}. Put the committed version back with:\n` +
                `   git checkout -- ${paths.join(' ')}\nCause: ${restoreError.message}`,
            )
          }
        }
      }
      if (restoreError) throw restoreError
      for (const [file, result] of Object.entries(results)) {
        shots[file] = {
          ref: session.ref,
          commit: usesBugSource ? bugHash : headHash,
          width: result.width,
          height: result.height,
          observed: result.observed,
        }
      }
    }
  } finally {
    browser.child.kill()
    await new Promise((resolve) => setTimeout(resolve, 300))
    rmSync(profileDir, { recursive: true, force: true })
  }

  const manifest = {
    capturedAt: new Date().toISOString().slice(0, 10),
    tool: 'scripts/capture-screenshots.mjs (Chrome DevTools protocol, headless)',
    browser: browser.browser,
    browserExecutable: path.basename(executable),
    viewport: { ...VIEWPORT, unit: 'CSS px' },
    colorScheme: COLOR_SCHEME,
    query: QUERY,
    sourceFiles: paths,
    shots,
  }
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  log(`\nWrote ${path.relative(repoRoot, MANIFEST_FILE)}.`)
  return manifest
}

function isMainModule() {
  if (!process.argv[1]) return false
  const argvUrl = pathToFileURL(path.resolve(process.argv[1])).href
  const own = import.meta.url
  return process.platform === 'win32' ? argvUrl.toLowerCase() === own.toLowerCase() : argvUrl === own
}

if (isMainModule()) {
  captureScreenshots()
    .then(() => {
      process.exitCode = 0
    })
    .catch((error) => {
      console.error(`\ncapture-screenshots: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
