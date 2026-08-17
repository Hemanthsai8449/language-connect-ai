import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const previewPort = 4174
const debuggingPort = 9555
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'language-connect-audit-'))
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForUrl(url, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The process is still starting.
    }
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function waitForPage() {
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

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  let nextId = 1

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  socket.addEventListener('message', async (event) => {
    const raw = typeof event.data === 'string' ? event.data : await event.data.text()
    const message = JSON.parse(raw)
    if (!message.id || !pending.has(message.id)) return
    const promise = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) promise.reject(new Error(message.error.message))
    else promise.resolve(message.result)
  })

  function send(method, params = {}) {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  return { send, close: () => socket.close() }
}

async function evaluate(send, expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Evaluation failed.')
  return response.result.value
}

async function waitFor(send, expression, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(send, expression)) return
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function setViewport(send, width, height, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  })
  await delay(350)
}

async function screenshot(send, filename) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const outputPath = path.join(tmpdir(), filename)
  await writeFile(outputPath, Buffer.from(result.data, 'base64'))
  return outputPath
}

const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(previewPort)],
  { cwd: projectRoot, stdio: 'ignore' },
)

let chrome
let client

try {
  const appUrl = `http://127.0.0.1:${previewPort}`
  await waitForUrl(appUrl)
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--no-first-run',
      `--remote-debugging-port=${debuggingPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDirectory}`,
      appUrl,
    ],
    { stdio: 'ignore' },
  )

  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { send } = client
  await send('Page.enable')
  await send('Runtime.enable')
  await setViewport(send, 390, 1000, true)
  await send('Page.navigate', { url: appUrl })
  await waitFor(send, "document.readyState === 'complete' && Boolean(document.querySelector('.translator-card'))")
  await evaluate(send, 'document.fonts?.ready ?? Promise.resolve(true)')
  await delay(700)

  const metrics = await evaluate(
    send,
    `(() => {
      const inspect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right },
          display: style.display,
          position: style.position,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          overflowX: style.overflowX,
          fontSize: style.fontSize,
        };
      };
      return {
        viewport: { innerWidth, clientWidth: document.documentElement.clientWidth },
        document: {
          htmlScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          scrollX,
        },
        header: inspect('.site-header'),
        brand: inspect('.site-header .brand'),
        actions: inspect('.header-actions'),
        main: inspect('main'),
        hero: inspect('.hero'),
        heroHeading: inspect('.hero h1'),
        translatorHeading: inspect('.translator-section__heading h2'),
        translatorCard: inspect('.translator-card'),
      };
    })()`,
  )

  const mobileScreenshot = await screenshot(send, 'language-connect-audit-mobile.png')
  await evaluate(
    send,
    "window.scrollTo({ top: document.querySelector('#translator').offsetTop - 78, behavior: 'instant' }); true",
  )
  await delay(350)
  const mobileTranslatorScreenshot = await screenshot(
    send,
    'language-connect-audit-mobile-translator.png',
  )
  await setViewport(send, 1440, 1200, false)
  await evaluate(send, "window.scrollTo({ top: 0, behavior: 'instant' }); true")
  await delay(500)
  const desktopScreenshot = await screenshot(send, 'language-connect-audit-desktop.png')
  const sectionScreenshots = {}
  for (const [name, selector] of [
    ['translator', '#translator'],
    ['languages', '#languages'],
    ['features', '#features'],
    ['footer', '.site-footer'],
  ]) {
    await evaluate(
      send,
      `window.scrollTo({ top: document.querySelector('${selector}').offsetTop - 108, behavior: 'instant' }); true`,
    )
    await delay(350)
    sectionScreenshots[name] = await screenshot(send, `language-connect-audit-${name}.png`)
  }

  await evaluate(
    send,
    `(() => {
      window.fetch = async () => new Response(JSON.stringify({
        translation: '\u092d\u093e\u0930\u0924 \u0915\u0940 \u0939\u0930 \u0906\u0935\u093e\u091c\u093c \u092e\u093e\u092f\u0928\u0947 \u0930\u0916\u0924\u0940 \u0939\u0948\u0964',
        sourceLanguage: 'en',
        targetLanguage: 'hi',
        requestId: 'visual-audit'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const textarea = document.querySelector('#source-text');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'Every voice in India deserves to be understood.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => {
        document.querySelector('.translator-card').requestSubmit();
        resolve(true);
      }, 160));
    })()`,
  )
  await waitFor(send, "Boolean(document.querySelector('.translated-text')?.textContent?.trim())")
  await evaluate(
    send,
    "window.scrollTo({ top: document.querySelector('#translator').offsetTop - 108, behavior: 'instant' }); true",
  )
  await delay(450)
  const translatedScreenshot = await screenshot(send, 'language-connect-audit-translated.png')

  await evaluate(send, "document.querySelector('.theme-toggle').click(); true")
  await evaluate(send, "window.scrollTo({ top: 0, behavior: 'instant' }); true")
  await delay(450)
  const lightScreenshot = await screenshot(send, 'language-connect-audit-light.png')
  console.log(
    JSON.stringify(
      {
        metrics,
        mobileScreenshot,
        mobileTranslatorScreenshot,
        desktopScreenshot,
        sectionScreenshots,
        translatedScreenshot,
        lightScreenshot,
      },
      null,
      2,
    ),
  )
} finally {
  client?.close()
  chrome?.kill()
  preview.kill()
}
