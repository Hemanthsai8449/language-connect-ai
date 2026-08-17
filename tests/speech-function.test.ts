import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { validateSpeechPayload } from '../netlify/functions/speech'

afterEach(() => {
  delete process.env.SARVAM_API_KEY
  vi.restoreAllMocks()
})

describe('speech Function', () => {
  it('accepts Bulbul languages and rejects unsupported cloud voices', () => {
    expect(validateSpeechPayload({ text: 'வணக்கம்', language: 'ta' })).toEqual({
      payload: { text: 'வணக்கம்', language: 'ta' },
    })
    expect(validateSpeechPayload({ text: 'নমস্কাৰ', language: 'as' })).toMatchObject({
      code: 'voice_unavailable',
    })
  })

  it('requires server-side credentials', async () => {
    const response = await handler(
      new Request('https://language-connect.example/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'வணக்கம்', language: 'ta' }),
      }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'configuration_error' },
    })
  })

  it('streams normalized audio from Sarvam without exposing the key', async () => {
    process.env.SARVAM_API_KEY = 'test-speech-key'
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([73, 68, 51, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    )

    const response = await handler(
      new Request('https://language-connect.example/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'ନମସ୍କାର', language: 'or' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([73, 68, 51, 4])

    const [, init] = providerFetch.mock.calls[0]
    expect(new Headers(init?.headers).get('api-subscription-key')).toBe('test-speech-key')
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'ନମସ୍କାର',
      language_code: 'od-IN',
      model: 'bulbul:v3',
      speaker: 'shubh',
      pace: 0.92,
      output_audio_codec: 'mp3',
      output_audio_bitrate: '128k',
    })
  })

  it('normalizes provider rate limits', async () => {
    process.env.SARVAM_API_KEY = 'test-speech-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429 }))

    const response = await handler(
      new Request('https://language-connect.example/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', language: 'en' }),
      }),
    )

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } })
  })
})
