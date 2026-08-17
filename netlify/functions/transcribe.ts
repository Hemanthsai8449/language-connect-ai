import {
  getLanguage,
  isLanguageCode,
  type LanguageCode,
} from '../../shared/languages.js'

interface TranscriptionPayload {
  audio: Blob
  language: LanguageCode
  filename: string
}

interface SarvamTranscriptionResponse {
  transcript?: string
  request_id?: string
}

interface SarvamErrorResponse {
  request_id?: unknown
  code?: unknown
  error?: { code?: unknown }
}

interface ValidationResult {
  payload?: TranscriptionPayload
  error?: string
  code?: string
  status?: number
}

const MAX_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 64 * 1024
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/webm',
  'video/webm',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'video/mp4',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
  'audio/x-aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
])

const FILE_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function jsonResponse(body: unknown, status = 200, additionalHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...additionalHeaders },
  })
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return jsonResponse({ error: { code, message, requestId } }, status, {
    'X-Request-Id': requestId,
  })
}

function readTimeout(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 40_000
  return Math.min(parsed, 50_000)
}

function baseMimeType(value: string) {
  return value.split(';', 1)[0].trim().toLowerCase()
}

function safeProviderMetadata(value: unknown) {
  if (typeof value !== 'string') return undefined
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128)
  return sanitized || undefined
}

async function logProviderRejection(response: Response, requestId: string) {
  const body = (await response.json().catch(() => ({}))) as SarvamErrorResponse
  console.warn('Sarvam transcription request rejected', {
    requestId,
    providerStatus: response.status,
    providerRequestId: safeProviderMetadata(body.request_id),
    providerCode: safeProviderMetadata(body.code ?? body.error?.code),
  })
}

export function validateTranscriptionPayload(
  audioEntry: FormDataEntryValue | null,
  languageEntry: FormDataEntryValue | null,
): ValidationResult {
  if (!(audioEntry instanceof Blob)) {
    return {
      status: 400,
      code: 'missing_audio',
      error: 'Record a short voice clip before transcribing.',
    }
  }

  if (!audioEntry.size) {
    return { status: 422, code: 'empty_audio', error: 'The recording did not contain any audio.' }
  }

  if (audioEntry.size > MAX_AUDIO_BYTES) {
    return {
      status: 413,
      code: 'audio_too_large',
      error: 'The recording is too large. Please record a shorter clip.',
    }
  }

  const mimeType = baseMimeType(audioEntry.type)
  if (!SUPPORTED_AUDIO_TYPES.has(mimeType)) {
    return {
      status: 415,
      code: 'unsupported_audio',
      error: 'This browser recorded an unsupported audio format.',
    }
  }

  if (!isLanguageCode(languageEntry)) {
    return {
      status: 422,
      code: 'unsupported_language',
      error: 'Choose a supported Indian language or English.',
    }
  }

  return {
    payload: {
      // Strip codec parameters (for example `audio/webm;codecs=opus`) before
      // forwarding. Some multipart parsers reject otherwise valid audio when
      // the per-file Content-Type contains codec metadata.
      audio: audioEntry.slice(0, audioEntry.size, mimeType),
      language: languageEntry,
      filename: `recording.${FILE_EXTENSIONS[mimeType] ?? 'webm'}`,
    },
  }
}

export default async function handler(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()

  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST to transcribe speech.', requestId)
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('multipart/form-data')) {
    return errorResponse(
      415,
      'invalid_content_type',
      'Content-Type must be multipart/form-data.',
      requestId,
    )
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return errorResponse(
      413,
      'audio_too_large',
      'The recording is too large. Please record a shorter clip.',
      requestId,
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return errorResponse(400, 'invalid_multipart', 'The audio upload could not be read.', requestId)
  }

  const validation = validateTranscriptionPayload(formData.get('file'), formData.get('language'))
  if (!validation.payload) {
    return errorResponse(
      validation.status ?? 422,
      validation.code ?? 'validation_error',
      validation.error ?? 'Check the speech recording.',
      requestId,
    )
  }

  const apiKey = process.env.SARVAM_API_KEY?.trim()
  if (!apiKey) {
    return errorResponse(
      503,
      'configuration_error',
      'The speech recognition service has not been configured.',
      requestId,
    )
  }

  const { audio, language, filename } = validation.payload
  const providerForm = new FormData()
  providerForm.append('file', audio, filename)
  providerForm.append('model', 'saaras:v3')
  providerForm.append('mode', 'transcribe')
  providerForm.append('language_code', getLanguage(language).providerCode)

  const timeoutSignal = AbortSignal.timeout(readTimeout(process.env.TRANSCRIPTION_TIMEOUT_MS))
  const signal = AbortSignal.any([request.signal, timeoutSignal])

  try {
    const providerResponse = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': apiKey },
      body: providerForm,
      signal,
    })

    if (!providerResponse.ok) {
      await logProviderRejection(providerResponse, requestId)

      if (providerResponse.status === 429) {
        return errorResponse(
          429,
          'rate_limited',
          'Voice recognition is busy. Please wait a moment and try again.',
          requestId,
        )
      }

      if (providerResponse.status === 401 || providerResponse.status === 403) {
        return errorResponse(
          503,
          'configuration_error',
          'The speech recognition credentials need attention.',
          requestId,
        )
      }

      if (providerResponse.status >= 500) {
        return errorResponse(
          503,
          'provider_unavailable',
          'The speech recognition service is temporarily unavailable.',
          requestId,
        )
      }

      if (providerResponse.status === 400 || providerResponse.status === 422) {
        return errorResponse(
          422,
          'invalid_audio',
          'The recording could not be read. Check the selected microphone and try again.',
          requestId,
        )
      }

      return errorResponse(
        422,
        'provider_rejected_request',
        `${getLanguage(language).name} speech could not be recognized.`,
        requestId,
      )
    }

    const providerBody = (await providerResponse.json().catch(() => ({}))) as SarvamTranscriptionResponse
    const transcript = providerBody.transcript?.trim()
    if (!transcript) {
      return errorResponse(
        422,
        'no_speech',
        'No speech was detected. Move closer to the microphone and try again.',
        requestId,
      )
    }

    return jsonResponse(
      { transcript, language, requestId },
      200,
      { 'X-Request-Id': requestId },
    )
  } catch (error) {
    if (timeoutSignal.aborted) {
      return errorResponse(
        504,
        'provider_timeout',
        'Speech recognition took too long. Please try again.',
        requestId,
      )
    }

    if (request.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return errorResponse(499, 'request_cancelled', 'Speech recognition was cancelled.', requestId)
    }

    return errorResponse(
      503,
      'provider_unavailable',
      'The speech recognition service could not be reached.',
      requestId,
    )
  }
}
