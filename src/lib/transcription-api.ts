import type { LanguageCode } from '../../shared/languages'

export interface TranscriptionResponse {
  transcript: string
  language: LanguageCode
  requestId: string
}

interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export class TranscriptionApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string

  constructor(message: string, code = 'unexpected_error', status = 500, requestId?: string) {
    super(message)
    this.name = 'TranscriptionApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

export async function requestTranscription(
  audio: Blob,
  filename: string,
  language: LanguageCode,
  signal?: AbortSignal,
): Promise<TranscriptionResponse> {
  const formData = new FormData()
  formData.append('file', audio, filename)
  formData.append('language', language)

  let response: Response
  try {
    response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error

    throw new TranscriptionApiError(
      navigator.onLine
        ? 'We could not reach the speech service. Please try again.'
        : 'You are offline. Reconnect and try again.',
      'network_error',
      0,
    )
  }

  const body = (await response.json().catch(() => ({}))) as TranscriptionResponse & ApiErrorBody
  if (!response.ok) {
    throw new TranscriptionApiError(
      body.error?.message ?? 'Speech could not be converted to text.',
      body.error?.code,
      response.status,
      body.error?.requestId,
    )
  }

  if (typeof body.transcript !== 'string' || !body.transcript.trim()) {
    throw new TranscriptionApiError(
      'No speech was detected in the recording.',
      'invalid_provider_response',
      502,
      body.requestId,
    )
  }

  return { ...body, transcript: body.transcript.trim() }
}
