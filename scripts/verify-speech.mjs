const response = await fetch('http://127.0.0.1:8888/api/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'வணக்கம்', language: 'ta' }),
})

const bytes = new Uint8Array(await response.arrayBuffer())
const result = {
  success: response.ok,
  status: response.status,
  contentType: response.headers.get('content-type'),
  audioBytes: bytes.length,
  headerBytes: Array.from(bytes.slice(0, 4)),
}

console.log(JSON.stringify(result, null, 2))

if (!response.ok || !result.contentType?.startsWith('audio/') || bytes.length === 0) {
  process.exitCode = 1
}
