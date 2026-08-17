const baseUrl = (process.env.VERIFY_BASE_URL || 'http://localhost:8888').replace(/\/$/u, '')

async function expectResponse(response, feature) {
  if (response.ok) return response

  let message = `${feature} returned HTTP ${response.status}`
  try {
    const body = await response.json()
    if (typeof body?.error?.message === 'string') message += `: ${body.error.message}`
  } catch {
    // Keep the status-only message for non-JSON failures.
  }

  throw new Error(message)
}

const pageResponse = await expectResponse(await fetch(baseUrl), 'Page')
const pageHtml = await pageResponse.text()

const translationResponse = await expectResponse(
  await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'hi' }),
  }),
  'Translation',
)
const translation = await translationResponse.json()

const speechResponse = await expectResponse(
  await fetch(`${baseUrl}/api/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello, this is a voice input test.', language: 'en' }),
  }),
  'Speech generation',
)
const audio = await speechResponse.blob()

const transcriptionForm = new FormData()
transcriptionForm.append('file', audio, 'verification.mp3')
transcriptionForm.append('language', 'en')

const transcriptionResponse = await expectResponse(
  await fetch(`${baseUrl}/api/transcribe`, {
    method: 'POST',
    body: transcriptionForm,
  }),
  'Speech transcription',
)
const transcription = await transcriptionResponse.json()

const result = {
  baseUrl,
  page: pageResponse.status,
  appLoaded: pageHtml.includes('Language Connect AI'),
  translation: translationResponse.status,
  translatedTextReturned: Boolean(translation.translation),
  speech: speechResponse.status,
  speechAudioBytes: audio.size,
  transcription: transcriptionResponse.status,
  transcriptReturned: Boolean(transcription.transcript),
}

console.log(JSON.stringify(result, null, 2))

if (
  !result.appLoaded ||
  !result.translatedTextReturned ||
  result.speechAudioBytes === 0 ||
  !result.transcriptReturned
) {
  process.exitCode = 1
}
