import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const videoPath = process.argv[2]
if (!videoPath) throw new Error('Pass a video path.')

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const debuggingPort = 9444
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'reference-video-chrome-'))
const outputDirectory = await mkdtemp(path.join(tmpdir(), 'reference-video-frames-'))
const videoUrl = pathToFileURL(path.resolve(videoPath)).href

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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

await mkdir(outputDirectory, { recursive: true })
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`,
    '--window-size=1920,1140',
    videoUrl,
  ],
  { stdio: 'ignore' },
)

let client
try {
  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { send } = client
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1140,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1920,
    screenHeight: 1140,
  })
  await waitFor(send, "Boolean(document.querySelector('video')?.duration)", 30_000)

  const duration = await evaluate(send, "document.querySelector('video').duration")
  const times = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]
    .filter((time) => time < duration)

  await evaluate(
    send,
    `(() => {
      const video = document.querySelector('video');
      video.pause();
      video.controls = false;
      document.documentElement.style.background = '#000';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      video.style.width = '100vw';
      video.style.height = '100vh';
      video.style.objectFit = 'contain';
      return true;
    })()`,
  )

  for (const time of times) {
    await evaluate(
      send,
      `new Promise((resolve) => {
        const video = document.querySelector('video');
        const finish = () => { video.removeEventListener('seeked', finish); resolve(true); };
        video.addEventListener('seeked', finish);
        video.currentTime = ${time};
        if (Math.abs(video.currentTime - ${time}) < 0.05 && video.readyState >= 2) finish();
      })`,
    )
    await delay(120)
    const screenshot = await send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 88,
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const filename = `frame-${String(time).padStart(2, '0')}s.jpg`
    await writeFile(path.join(outputDirectory, filename), Buffer.from(screenshot.data, 'base64'))
  }

  console.log(JSON.stringify({ outputDirectory, duration, frameCount: times.length }))
} finally {
  client?.close()
  chrome.kill()
}
