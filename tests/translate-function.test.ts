import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { validatePayload } from '../netlify/functions/translate'

afterEach(() => {
  delete process.env.SARVAM_API_KEY
  vi.restoreAllMocks()
})

describe('translation request validation', () => {
  it('accepts a supported language pair', () => {
    expect(
      validatePayload({ text: 'Namaste', sourceLanguage: 'en', targetLanguage: 'hi' }),
    ).toEqual({
      payload: { text: 'Namaste', sourceLanguage: 'en', targetLanguage: 'hi' },
    })
  })

  it('rejects unsupported foreign languages', () => {
    expect(
      validatePayload({ text: 'Bonjour', sourceLanguage: 'fr', targetLanguage: 'en' }).error,
    ).toMatch(/supported Indian language or English/i)
  })

  it('rejects the same source and target language', () => {
    expect(
      validatePayload({ text: 'नमस्ते', sourceLanguage: 'hi', targetLanguage: 'hi' }).error,
    ).toMatch(/different languages/i)
  })

  it('enforces the configured character limit', () => {
    expect(
      validatePayload({ text: 'abcd', sourceLanguage: 'en', targetLanguage: 'te' }, 3).error,
    ).toMatch(/3 characters or fewer/i)
  })

  it('keeps provider configuration errors server-side', async () => {
    const response = await handler(
      new Request('https://language-connect.example/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'hi' }),
      }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'configuration_error' },
    })
  })

  it('normalizes a successful Sarvam response', async () => {
    process.env.SARVAM_API_KEY = 'test-key'
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ translated_text: 'ನಮಸ್ಕಾರ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const response = await handler(
      new Request('https://language-connect.example/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'kn' }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      translation: 'ನಮಸ್ಕಾರ',
      sourceLanguage: 'en',
      targetLanguage: 'kn',
    })
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.sarvam.ai/translate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          input: 'Hello',
          source_language_code: 'en-IN',
          target_language_code: 'kn-IN',
          model: 'sarvam-translate:v1',
        }),
      }),
    )
  })
})
