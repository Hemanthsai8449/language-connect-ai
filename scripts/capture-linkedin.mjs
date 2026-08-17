import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const outputDirectory = path.join(projectRoot, 'social')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const appUrl = 'http://127.0.0.1:8888'
const debuggingPort = 9333

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForDebugPage() {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json`)
      const pages = await response.json()
      const page = pages.find((candidate) => candidate.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // Chrome is still starting.
    }

    await delay(200)
  }

  throw new Error('Chrome DevTools did not become ready.')
}

async function connectToPage(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  let nextId = 1

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  socket.addEventListener('message', async (event) => {
    const rawMessage = typeof event.data === 'string' ? event.data : await event.data.text()
    const message = JSON.parse(rawMessage)
    if (!message.id || !pending.has(message.id)) return

    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)

    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })

  function send(method, params = {}) {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
  }

  return { send, close: () => socket.close() }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Page evaluation failed.')
  }

  return result.result.value
}

async function waitFor(send, expression, timeout = 20_000) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (await evaluate(send, expression)) return
    await delay(250)
  }

  throw new Error(`Timed out waiting for: ${expression}`)
}

async function capture(send, filename) {
  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  await writeFile(path.join(outputDirectory, filename), Buffer.from(screenshot.data, 'base64'))
}

await mkdir(outputDirectory, { recursive: true })
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'language-connect-social-'))

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--no-first-run',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`,
    '--window-size=1440,1050',
    appUrl,
  ],
  { stdio: 'ignore' },
)

let client

try {
  const page = await waitForDebugPage()
  client = await connectToPage(page.webSocketDebuggerUrl)
  const { send } = client

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 1050,
  })

  await waitFor(send, "document.readyState === 'complete' && Boolean(document.querySelector('#source-text'))")
  await evaluate(
    send,
    `(() => {
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('language-connect-theme', 'light');
      const textarea = document.querySelector('#source-text');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      valueSetter.call(textarea, 'India speaks in many voices, and technology should help every one of them be heard.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise((resolve) => {
        setTimeout(() => {
          document.querySelector('.translator-card').requestSubmit();
          resolve(true);
        }, 200);
      });
    })()`,
  )

  await waitFor(send, "Boolean(document.querySelector('.translated-text')?.textContent?.trim())", 30_000)
  await delay(700)
  await evaluate(send, 'window.scrollTo({ top: 0, behavior: \'instant\' }); true')
  await capture(send, 'language-connect-ai-linkedin-desktop.png')

  await send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 912,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 430,
    screenHeight: 912,
  })
  await delay(500)
  await evaluate(
    send,
    `(() => {
      const card = document.querySelector('.translator-card');
      document.querySelector('.hero').style.visibility = 'hidden';
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 76, behavior: 'instant' });
      return true;
    })()`,
  )
  await delay(300)
  await capture(send, 'language-connect-ai-linkedin-mobile.png')

  console.log(`Created LinkedIn screenshots in ${outputDirectory}`)
} finally {
  client?.close()
  chrome.kill()
  await delay(300)
  await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined)
}
