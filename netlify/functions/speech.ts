import {
  getLanguage,
  isLanguageCode,
  MAX_INPUT_CHARACTERS,
  supportsSarvamTts,
  type LanguageCode,
} from '../../shared/languages.js'

interface SpeechPayload {
  text: string
  language: LanguageCode
}

interface ValidationResult {
  payload?: SpeechPayload
  error?: string
  code?: string
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return jsonResponse({ error: { code, message, requestId } }, status)
}

function readTimeout(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 45_000
  return Math.min(parsed, 60_000)
}

export function validateSpeechPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { code: 'invalid_payload', error: 'Send a JSON object with text and language.' }
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.text !== 'string' || !candidate.text.trim()) {
    return { code: 'validation_error', error: 'There is no translated text to read.' }
  }

  if (candidate.text.length > MAX_INPUT_CHARACTERS) {
    return {
      code: 'text_too_long',
      error: `Speech text must be ${MAX_INPUT_CHARACTERS.toLocaleString('en-IN')} characters or fewer.`,
    }
  }

  if (!isLanguageCode(candidate.language)) {
    return { code: 'unsupported_language', error: 'Choose a supported Indian language or English.' }
  }

  if (!supportsSarvamTts(candidate.language)) {
    return {
      code: 'voice_unavailable',
      error: 'Cloud voice is not available for this language.',
    }
  }

  return {
    payload: {
      text: candidate.text.trim(),
      language: candidate.language,
    },
  }
}

export default async function handler(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()

  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST to create speech.', requestId)
  }

  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return errorResponse(415, 'invalid_content_type', 'Content-Type must be application/json.', requestId)
  }

  let rawPayload: unknown
  try {
    rawPayload = await request.json()
  } catch {
    return errorResponse(400, 'invalid_json', 'The request body is not valid JSON.', requestId)
  }

  const validation = validateSpeechPayload(rawPayload)
  if (!validation.payload) {
    return errorResponse(
      validation.code === 'voice_unavailable' ? 422 : 400,
      validation.code ?? 'validation_error',
      validation.error ?? 'Check the speech request.',
      requestId,
    )
  }

  const apiKey = process.env.SARVAM_API_KEY?.trim()
  if (!apiKey) {
    return errorResponse(
      503,
      'configuration_error',
      'The speech service has not been configured.',
      requestId,
    )
  }

  const { text, language } = validation.payload
  const target = getLanguage(language)
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(readTimeout(process.env.SPEECH_TIMEOUT_MS)),
  ])

  try {
    const providerResponse = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify({
        text,
        language_code: target.providerCode,
        model: 'bulbul:v3',
        speaker: 'shubh',
        pace: 0.92,
        output_audio_codec: 'mp3',
        output_audio_bitrate: '128k',
      }),
      signal,
    })

    if (!providerResponse.ok) {
      if (providerResponse.status === 429) {
        return errorResponse(
          429,
          'rate_limited',
          'Voice generation is busy. Please wait a moment and try again.',
          requestId,
        )
      }

      if (providerResponse.status === 401 || providerResponse.status === 403) {
        return errorResponse(
          503,
          'configuration_error',
          'The speech service credentials need attention.',
          requestId,
        )
      }

      if (providerResponse.status >= 500) {
        return errorResponse(
          503,
          'provider_unavailable',
          'The voice service is temporarily unavailable.',
          requestId,
        )
      }

      return errorResponse(
        422,
        'provider_rejected_request',
        `${target.name} speech could not be generated.`,
        requestId,
      )
    }

    if (!providerResponse.body) {
      return errorResponse(502, 'empty_audio', 'The voice service returned no audio.', requestId)
    }

    return new Response(providerResponse.body, {
      status: 200,
      headers: {
        'Content-Type': providerResponse.headers.get('content-type') ?? 'audio/mpeg',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return errorResponse(504, 'provider_timeout', 'Voice generation took too long.', requestId)
    }

    return errorResponse(
      503,
      'provider_unavailable',
      'The voice service could not be reached.',
      requestId,
    )
  }
}
