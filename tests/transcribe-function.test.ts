import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { validateTranscriptionPayload } from '../netlify/functions/transcribe'
import { LANGUAGES } from '../shared/languages'

function transcriptionRequest(
  language = 'en',
  type = 'audio/webm;codecs=opus',
  contents = 'recorded audio',
) {
  const formData = new FormData()
  formData.append('file', new File([contents], 'voice.webm', { type }))
  formData.append('language', language)
  const request = new Request('https://language-connect.example/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
    body: '--test--',
  })
  Object.defineProperty(request, 'formData', {
    configurable: true,
    value: async () => formData,
  })
  return request
}

afterEach(() => {
  delete process.env.SARVAM_API_KEY
  delete process.env.TRANSCRIPTION_TIMEOUT_MS
  vi.restoreAllMocks()
})

describe('transcription Function', () => {
  it('accepts recorded audio for every app language', () => {
    const audio = new File(['audio'], 'voice.webm', { type: 'audio/webm;codecs=opus' })

    for (const language of LANGUAGES) {
      expect(validateTranscriptionPayload(audio, language.code)).toMatchObject({
        payload: { language: language.code, filename: 'recording.webm' },
      })
    }
  })

  it('rejects missing, unsupported, and oversized audio', () => {
    expect(validateTranscriptionPayload(null, 'en')).toMatchObject({ code: 'missing_audio' })
    expect(
      validateTranscriptionPayload(new File(['text'], 'voice.txt', { type: 'text/plain' }), 'en'),
    ).toMatchObject({ code: 'unsupported_audio', status: 415 })
    expect(
      validateTranscriptionPayload(
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'voice.webm', { type: 'audio/webm' }),
        'en',
      ),
    ).toMatchObject({ code: 'audio_too_large', status: 413 })
  })

  it('rejects unsupported foreign languages', () => {
    const audio = new File(['audio'], 'voice.webm', { type: 'audio/webm' })
    expect(validateTranscriptionPayload(audio, 'fr')).toMatchObject({
      code: 'unsupported_language',
    })
  })

  it('requires POST multipart requests and enforces the upload limit early', async () => {
    const getResponse = await handler(new Request('https://language-connect.example/api/transcribe'))
    expect(getResponse.status).toBe(405)

    const jsonResponse = await handler(
      new Request('https://language-connect.example/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(jsonResponse.status).toBe(415)

    const largeResponse = await handler(
      new Request('https://language-connect.example/api/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=test',
          'Content-Length': String(3 * 1024 * 1024),
        },
        body: '--test--',
      }),
    )
    expect(largeResponse.status).toBe(413)
    await expect(largeResponse.json()).resolves.toMatchObject({
      error: { code: 'audio_too_large' },
    })
  })

  it('keeps Sarvam credentials on the server', async () => {
    const response = await handler(transcriptionRequest())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'configuration_error' },
    })
  })

  it('forwards safe multipart audio and normalizes a successful transcript', async () => {
    process.env.SARVAM_API_KEY = 'test-transcription-key'
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ transcript: 'ନମସ୍କାର', request_id: 'provider-request' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const response = await handler(transcriptionRequest('or'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      transcript: 'ନମସ୍କାର',
      language: 'or',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')

    const [url, init] = providerFetch.mock.calls[0]
    expect(url).toBe('https://api.sarvam.ai/speech-to-text')
    const headers = new Headers(init?.headers)
    expect(headers.get('api-subscription-key')).toBe('test-transcription-key')
    expect(headers.has('content-type')).toBe(false)
    const body = init?.body as FormData
    expect(body.get('model')).toBe('saaras:v3')
    expect(body.get('mode')).toBe('transcribe')
    expect(body.get('language_code')).toBe('od-IN')
    const providerFile = body.get('file') as File
    expect(providerFile.name).toBe('recording.webm')
    expect(providerFile.type).toBe('audio/webm')
    expect(providerFile.size).toBeGreaterThan(0)
  })

  it('normalizes provider rate limits and empty transcripts', async () => {
    process.env.SARVAM_API_KEY = 'test-transcription-key'
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 429 }))

    const limited = await handler(transcriptionRequest())
    expect(limited.status).toBe(429)
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } })

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ transcript: '   ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const silent = await handler(transcriptionRequest())
    expect(silent.status).toBe(422)
    await expect(silent.json()).resolves.toMatchObject({ error: { code: 'no_speech' } })
  })

  it('returns a safe invalid-audio error and logs only sanitized provider metadata', async () => {
    process.env.SARVAM_API_KEY = 'test-transcription-key'
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          request_id: 'provider_request-123',
          code: 'invalid_audio',
          detail: 'raw provider detail that must not be exposed',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const response = await handler(transcriptionRequest())
    const responseBody = await response.json()

    expect(response.status).toBe(422)
    expect(responseBody).toMatchObject({ error: { code: 'invalid_audio' } })
    expect(JSON.stringify(responseBody)).not.toContain('raw provider detail')
    expect(warning).toHaveBeenCalledWith(
      'Sarvam transcription request rejected',
      expect.objectContaining({
        providerStatus: 400,
        providerRequestId: 'provider_request-123',
        providerCode: 'invalid_audio',
      }),
    )
    expect(JSON.stringify(warning.mock.calls[0][1])).not.toContain('raw provider detail')
  })
})
