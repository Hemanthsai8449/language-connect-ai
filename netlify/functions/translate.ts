import {
  getLanguage,
  isLanguageCode,
  MAX_INPUT_CHARACTERS,
  type LanguageCode,
} from '../../shared/languages.js'

interface TranslationPayload {
  text: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
}

interface SarvamTranslationResponse {
  translated_text?: string
  request_id?: string
}

interface ValidationResult {
  payload?: TranslationPayload
  error?: string
}

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function jsonResponse(body: unknown, status = 200, additionalHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...additionalHeaders },
  })
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return jsonResponse({ error: { code, message, requestId } }, status)
}

function readPositiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, maximum)
}

export function validatePayload(value: unknown, maxCharacters = MAX_INPUT_CHARACTERS): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Send a JSON object with text, sourceLanguage, and targetLanguage.' }
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.text !== 'string' || !candidate.text.trim()) {
    return { error: 'Enter some text to translate.' }
  }

  if (candidate.text.length > maxCharacters) {
    return { error: `Text must be ${maxCharacters.toLocaleString('en-IN')} characters or fewer.` }
  }

  if (!isLanguageCode(candidate.sourceLanguage) || !isLanguageCode(candidate.targetLanguage)) {
    return { error: 'Choose a supported Indian language or English.' }
  }

  if (candidate.sourceLanguage === candidate.targetLanguage) {
    return { error: 'Choose two different languages.' }
  }

  return {
    payload: {
      text: candidate.text.trim(),
      sourceLanguage: candidate.sourceLanguage,
      targetLanguage: candidate.targetLanguage,
    },
  }
}

export default async function handler(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()

  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST to translate text.', requestId)
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse(415, 'invalid_content_type', 'Content-Type must be application/json.', requestId)
  }

  const maxCharacters = readPositiveInteger(
    process.env.MAX_INPUT_CHARACTERS,
    MAX_INPUT_CHARACTERS,
    MAX_INPUT_CHARACTERS,
  )
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (contentLength > maxCharacters * 4 + 1024) {
    return errorResponse(413, 'text_too_long', `Text must be ${maxCharacters} characters or fewer.`, requestId)
  }

  let rawPayload: unknown
  try {
    rawPayload = await request.json()
  } catch {
    return errorResponse(400, 'invalid_json', 'The request body is not valid JSON.', requestId)
  }

  const validation = validatePayload(rawPayload, maxCharacters)
  if (!validation.payload) {
    return errorResponse(422, 'validation_error', validation.error ?? 'Check the translation request.', requestId)
  }

  const apiKey = process.env.SARVAM_API_KEY?.trim()
  if (!apiKey) {
    return errorResponse(
      503,
      'configuration_error',
      'The translation service has not been configured.',
      requestId,
    )
  }

  const { text, sourceLanguage, targetLanguage } = validation.payload
  const source = getLanguage(sourceLanguage)
  const target = getLanguage(targetLanguage)
  const timeoutMs = readPositiveInteger(process.env.TRANSLATION_TIMEOUT_MS, 25_000, 45_000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromClient = () => controller.abort()
  request.signal.addEventListener('abort', abortFromClient, { once: true })

  try {
    const providerResponse = await fetch('https://api.sarvam.ai/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify({
        input: text,
        source_language_code: source.providerCode,
        target_language_code: target.providerCode,
        model: 'sarvam-translate:v1',
      }),
      signal: controller.signal,
    })

    if (!providerResponse.ok) {
      if (providerResponse.status === 429) {
        return errorResponse(
          429,
          'rate_limited',
          'Too many translations were requested. Please try again shortly.',
          requestId,
        )
      }

      if (providerResponse.status === 401 || providerResponse.status === 403) {
        return errorResponse(
          503,
          'configuration_error',
          'The translation service credentials need attention.',
          requestId,
        )
      }

      if (providerResponse.status >= 500) {
        return errorResponse(
          503,
          'provider_unavailable',
          'The translation provider is temporarily unavailable.',
          requestId,
        )
      }

      return errorResponse(
        422,
        'provider_rejected_request',
        `This ${source.name} to ${target.name} translation could not be completed.`,
        requestId,
      )
    }

    const providerBody = (await providerResponse.json()) as SarvamTranslationResponse
    const translatedText = providerBody.translated_text?.trim()

    if (!translatedText) {
      return errorResponse(
        502,
        'invalid_provider_response',
        'The translation provider returned an empty response.',
        requestId,
      )
    }

    return jsonResponse({
      translation: translatedText,
      sourceLanguage,
      targetLanguage,
      requestId,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return errorResponse(
        504,
        'provider_timeout',
        'Translation took too long. Please try again.',
        requestId,
      )
    }

    return errorResponse(
      503,
      'provider_unavailable',
      'The translation provider could not be reached.',
      requestId,
    )
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abortFromClient)
  }
}
