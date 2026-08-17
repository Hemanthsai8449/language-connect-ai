import type { LanguageCode } from '../../shared/languages'

interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export class SpeechApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'unexpected_error', status = 500) {
    super(message)
    this.name = 'SpeechApiError'
    this.code = code
    this.status = status
  }
}

export async function requestSpeech(
  text: string,
  language: LanguageCode,
  signal?: AbortSignal,
): Promise<Blob> {
  let response: Response

  try {
    response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new SpeechApiError('The voice service could not be reached.', 'network_error', 0)
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody
    throw new SpeechApiError(
      body.error?.message ?? 'Voice generation did not complete.',
      body.error?.code,
      response.status,
    )
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('audio/')) {
    throw new SpeechApiError('The voice service returned an invalid audio response.', 'invalid_audio', 502)
  }

  const audio = await response.blob()
  if (!audio.size) {
    throw new SpeechApiError('The voice service returned empty audio.', 'empty_audio', 502)
  }

  return audio
}
