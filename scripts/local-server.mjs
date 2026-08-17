import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(import.meta.dirname, '..')
const distDirectory = resolve(projectRoot, 'dist')
const host = process.env.LOCAL_HOST?.trim() || '127.0.0.1'
const port = Number.parseInt(process.env.LOCAL_PORT || '8888', 10)

const functionFiles = {
  '/api/translate': resolve(
    projectRoot,
    '.netlify/functions-serve/translate/netlify/functions/translate.mjs',
  ),
  '/api/speech': resolve(
    projectRoot,
    '.netlify/functions-serve/speech/netlify/functions/speech.mjs',
  ),
  '/api/transcribe': resolve(
    projectRoot,
    '.netlify/functions-serve/transcribe/netlify/functions/transcribe.mjs',
  ),
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function loadLocalEnvironment() {
  const envFile = resolve(projectRoot, '.env')
  if (!existsSync(envFile)) return

  for (const rawLine of readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

function sendText(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(message)
}

async function readRequestBody(request, maximumBytes = 3 * 1024 * 1024) {
  const chunks = []
  let totalBytes = 0

  for await (const chunk of request) {
    totalBytes += chunk.length
    if (totalBytes > maximumBytes) throw new Error('request_too_large')
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function runFunction(handler, incomingRequest, outgoingResponse, requestUrl) {
  try {
    const body = ['GET', 'HEAD'].includes(incomingRequest.method || 'GET')
      ? undefined
      : await readRequestBody(incomingRequest)
    const controller = new AbortController()
    incomingRequest.once('aborted', () => controller.abort())

    const webRequest = new Request(requestUrl, {
      method: incomingRequest.method,
      headers: incomingRequest.headers,
      body,
      signal: controller.signal,
    })
    const webResponse = await handler(webRequest)

    outgoingResponse.statusCode = webResponse.status
    for (const [name, value] of webResponse.headers) outgoingResponse.setHeader(name, value)

    if (incomingRequest.method === 'HEAD' || !webResponse.body) {
      outgoingResponse.end()
      return
    }

    outgoingResponse.end(Buffer.from(await webResponse.arrayBuffer()))
  } catch (error) {
    if (error instanceof Error && error.message === 'request_too_large') {
      sendText(outgoingResponse, 413, 'Request body is too large.')
      return
    }

    console.error('Local function request failed:', error instanceof Error ? error.message : error)
    if (!outgoingResponse.headersSent) {
      sendText(outgoingResponse, 500, 'The local API encountered an unexpected error.')
    } else {
      outgoingResponse.end()
    }
  }
}

function serveStaticFile(incomingRequest, outgoingResponse, pathname) {
  let decodedPath
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    sendText(outgoingResponse, 400, 'Invalid URL.')
    return
  }

  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath
  let filePath = resolve(distDirectory, `.${requestedPath}`)
  const relativePath = relative(distDirectory, filePath)

  if (relativePath.startsWith('..') || relativePath.includes(':')) {
    sendText(outgoingResponse, 403, 'Forbidden.')
    return
  }

  if (!existsSync(filePath)) filePath = resolve(distDirectory, 'index.html')

  const content = readFileSync(filePath)
  outgoingResponse.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
    'X-Content-Type-Options': 'nosniff',
  })
  outgoingResponse.end(incomingRequest.method === 'HEAD' ? undefined : content)
}

loadLocalEnvironment()

if (!existsSync(resolve(distDirectory, 'index.html'))) {
  throw new Error('The production build is missing. Run `npm run build` first.')
}

for (const [route, functionFile] of Object.entries(functionFiles)) {
  if (!existsSync(functionFile)) {
    throw new Error(`The bundled function for ${route} is missing. Run Netlify Dev once to rebuild it.`)
  }
}

const handlers = Object.fromEntries(
  await Promise.all(
    Object.entries(functionFiles).map(async ([route, functionFile]) => {
      const module = await import(pathToFileURL(functionFile).href)
      return [route, module.default]
    }),
  ),
)

const server = createServer(async (incomingRequest, outgoingResponse) => {
  const requestUrl = new URL(incomingRequest.url || '/', `http://${host}:${port}`)
  const handler = handlers[requestUrl.pathname]

  if (handler) {
    await runFunction(handler, incomingRequest, outgoingResponse, requestUrl)
    return
  }

  if (!['GET', 'HEAD'].includes(incomingRequest.method || 'GET')) {
    sendText(outgoingResponse, 404, 'Not found.')
    return
  }

  serveStaticFile(incomingRequest, outgoingResponse, requestUrl.pathname)
})

server.listen(port, host, () => {
  console.log(`Language Connect AI is running at http://localhost:${port}`)
  console.log('Local Translate, Listen, and Speak API routes are active.')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
