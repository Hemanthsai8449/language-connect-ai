import type { LanguageCode } from '../../shared/languages'

export interface TranslationResponse {
  translation: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  requestId: string
}

interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export class TranslationApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string

  constructor(message: string, code = 'unexpected_error', status = 500, requestId?: string) {
    super(message)
    this.name = 'TranslationApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

export async function requestTranslation(
  text: string,
  sourceLanguage: LanguageCode,
  targetLanguage: LanguageCode,
  signal?: AbortSignal,
): Promise<TranslationResponse> {
  let response: Response

  try {
    response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLanguage, targetLanguage }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }

    throw new TranslationApiError(
      navigator.onLine
        ? 'We could not reach the translation service. Please try again.'
        : 'You are offline. Reconnect and try again.',
      'network_error',
      0,
    )
  }

  const body = (await response.json().catch(() => ({}))) as TranslationResponse & ApiErrorBody

  if (!response.ok) {
    throw new TranslationApiError(
      body.error?.message ?? 'Translation did not complete. Please try again.',
      body.error?.code,
      response.status,
      body.error?.requestId,
    )
  }

  return body
}
