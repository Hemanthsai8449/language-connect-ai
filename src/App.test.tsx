import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeRecordingToWav, RecordingAudioError } from './lib/audio-processing'
import App from './App'

vi.mock('./lib/audio-processing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/audio-processing')>()
  return { ...actual, normalizeRecordingToWav: vi.fn() }
})

const normalizeRecordingMock = vi.mocked(normalizeRecordingToWav)

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static nextBlob = new Blob(['recorded audio'], { type: 'audio/webm;codecs=opus' })

  static isTypeSupported(type: string) {
    return type.startsWith('audio/webm')
  }

  readonly stream: MediaStream
  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: (() => void) | null = null
  onstart: (() => void) | null = null
  onstop: (() => void) | null = null

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream
    this.mimeType = options?.mimeType ?? 'audio/webm;codecs=opus'
    FakeMediaRecorder.instances.push(this)
  }

  start = vi.fn(() => {
    this.state = 'recording'
    this.onstart?.()
  })

  stop = vi.fn(() => {
    if (this.state === 'inactive') throw new DOMException('Recorder is inactive', 'InvalidStateError')
    this.state = 'inactive'
    this.ondataavailable?.({ data: FakeMediaRecorder.nextBlob } as BlobEvent)
    this.onstop?.()
  })
}

function installMediaRecorder(getUserMediaError?: unknown) {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.nextBlob = new Blob(['recorded audio'], { type: 'audio/webm;codecs=opus' })
  const stopTrack = vi.fn()
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream
  const getUserMedia = getUserMediaError
    ? vi.fn().mockRejectedValue(getUserMediaError)
    : vi.fn().mockResolvedValue(stream)

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: { getUserMedia },
  })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

  return { getUserMedia, stopTrack, stream }
}

beforeEach(() => {
  normalizeRecordingMock.mockReset()
  normalizeRecordingMock.mockResolvedValue(new Blob(['normalized wav'], { type: 'audio/wav' }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeMediaRecorder.instances = []
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Reflect.deleteProperty(window, 'isSecureContext')
})

describe('Language Connect AI', () => {
  it('presents the translator with accessible controls', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: /every voice, closer/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Translate from')).toHaveValue('en')
    expect(screen.getByLabelText('Translate to')).toHaveValue('hi')
    expect(screen.getByLabelText('Text to translate')).toHaveAttribute('maxlength', '2000')
    expect(screen.getByRole('button', { name: /translate to hindi/i })).toBeDisabled()
  })

  it('records speech, uploads multipart audio, and appends the transcript to the latest text', async () => {
    const { getUserMedia, stopTrack } = installMediaRecorder()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ transcript: 'hello world', language: 'en', requestId: 'speech-request' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
    expect(screen.getByText(/waiting for microphone access/i)).toBeInTheDocument()
    await screen.findByRole('button', { name: /stop listening/i })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })

    fireEvent.change(screen.getByLabelText('Text to translate'), {
      target: { value: 'Already typed' },
    })
    fireEvent.click(screen.getByRole('button', { name: /stop listening/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Text to translate')).toHaveValue('Already typed hello world')
    })
    expect(screen.getByText('Voice input added.')).toBeInTheDocument()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/transcribe')
    expect(init).toMatchObject({ method: 'POST' })
    expect(init?.headers).toBeUndefined()
    const body = init?.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('language')).toBe('en')
    const recording = body.get('file') as File
    expect(recording).toBeInstanceOf(Blob)
    expect(recording.type).toBe('audio/wav')
    expect(recording.name).toBe('recording.wav')
    expect(normalizeRecordingMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio/webm;codecs=opus' }),
      expect.any(AbortSignal),
    )
  })

  it.each([
    ['NotAllowedError', /microphone access is blocked/i],
    ['NotFoundError', /no microphone was found/i],
    ['NotReadableError', /microphone is busy or unavailable/i],
  ])('reports an actionable %s microphone error', async (errorName, message) => {
    installMediaRecorder(new DOMException('Microphone error', errorName))
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /speak in english/i })).toBeInTheDocument()
  })

  it('cancels recording and releases the microphone when the source language changes', async () => {
    const { stopTrack } = installMediaRecorder()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
    await screen.findByRole('button', { name: /stop listening/i })
    const instance = FakeMediaRecorder.instances[0]
    fireEvent.change(screen.getByLabelText('Translate from'), { target: { value: 'ta' } })

    expect(instance.stop).toHaveBeenCalledOnce()
    expect(instance.ondataavailable).toBeNull()
    expect(instance.onstop).toBeNull()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /speak in tamil/i })).toBeInTheDocument()
  })

  it('stops the microphone and detaches recorder callbacks when the app unmounts', async () => {
    const { stopTrack } = installMediaRecorder()
    const { unmount } = render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
    await screen.findByRole('button', { name: /stop listening/i })
    const instance = FakeMediaRecorder.instances[0]
    unmount()

    expect(instance.stop).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(instance.onstart).toBeNull()
    expect(instance.ondataavailable).toBeNull()
    expect(instance.onerror).toBeNull()
    expect(instance.onstop).toBeNull()
  })

  it('stops recording automatically after twenty seconds', async () => {
    vi.useFakeTimers()
    installMediaRecorder()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ transcript: 'automatic stop', language: 'en', requestId: 'speech-request' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<App />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
      await Promise.resolve()
    })
    const instance = FakeMediaRecorder.instances[0]
    act(() => vi.advanceTimersByTime(20_000))

    expect(instance.stop).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('shows a useful message when Sarvam detects no speech', async () => {
    installMediaRecorder()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'no_speech', message: 'No speech was detected.' } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
    await screen.findByRole('button', { name: /stop listening/i })
    fireEvent.click(screen.getByRole('button', { name: /stop listening/i }))

    expect(await screen.findByText(/no speech was detected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /speak in english/i })).toBeInTheDocument()
  })

  it('distinguishes a silent or muted microphone without calling Sarvam', async () => {
    installMediaRecorder()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    normalizeRecordingMock.mockRejectedValueOnce(
      new RecordingAudioError('Silent recording', 'audio_too_quiet'),
    )
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /speak in english/i }))
    await screen.findByRole('button', { name: /stop listening/i })
    fireEvent.click(screen.getByRole('button', { name: /stop listening/i }))

    expect(await screen.findByText(/could barely hear any audio/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends an allowlisted request and renders the translation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          translation: 'नमस्ते दुनिया',
          sourceLanguage: 'en',
          targetLanguage: 'hi',
          requestId: 'test-request',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<App />)

    fireEvent.change(screen.getByLabelText('Text to translate'), {
      target: { value: 'Hello world' },
    })
    fireEvent.click(screen.getByRole('button', { name: /translate to hindi/i }))

    await waitFor(() => expect(screen.getByText('नमस्ते दुनिया')).toBeInTheDocument())
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/translate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Hello world', sourceLanguage: 'en', targetLanguage: 'hi' }),
      }),
    )
  })

  it('swaps the completed translation back into the input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          translation: 'வணக்கம்',
          sourceLanguage: 'en',
          targetLanguage: 'ta',
          requestId: 'test-request',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<App />)

    fireEvent.change(screen.getByLabelText('Translate to'), { target: { value: 'ta' } })
    fireEvent.change(screen.getByLabelText('Text to translate'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: /translate to tamil/i }))
    await screen.findByText('வணக்கம்')

    fireEvent.click(screen.getByRole('button', { name: /swap english and tamil/i }))

    expect(screen.getByLabelText('Text to translate')).toHaveValue('வணக்கம்')
    expect(screen.getByLabelText('Translate from')).toHaveValue('ta')
    expect(screen.getByLabelText('Translate to')).toHaveValue('en')
  })

  it('uses the protected cloud speech endpoint for a supported Tamil voice', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            translation: 'வணக்கம்',
            sourceLanguage: 'en',
            targetLanguage: 'ta',
            requestId: 'translation-request',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([73, 68, 51, 4]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      )
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function () {
      this.dispatchEvent(new Event('playing'))
    })
    render(<App />)

    fireEvent.change(screen.getByLabelText('Translate to'), { target: { value: 'ta' } })
    fireEvent.change(screen.getByLabelText('Text to translate'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: /translate to tamil/i }))
    await screen.findByText('வணக்கம்')

    fireEvent.click(screen.getByRole('button', { name: /listen to tamil translation/i }))

    await waitFor(() => expect(screen.getByText(/playing a natural tamil voice/i)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/speech',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'வணக்கம்', language: 'ta' }),
      }),
    )
  })

  it('explains when neither Sarvam nor the device has a matching voice', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          translation: 'बरʼ',
          sourceLanguage: 'en',
          targetLanguage: 'brx',
          requestId: 'translation-request',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const deviceSpeak = vi.spyOn(window.speechSynthesis, 'speak')
    render(<App />)

    fireEvent.change(screen.getByLabelText('Translate to'), { target: { value: 'brx' } })
    fireEvent.change(screen.getByLabelText('Text to translate'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: /translate to bodo/i }))
    await screen.findByText('बरʼ')
    fireEvent.click(screen.getByRole('button', { name: /listen to bodo translation/i }))

    expect(
      screen.getByText(/bodo voice is not available from sarvam or on this device/i),
    ).toBeInTheDocument()
    expect(deviceSpeak).not.toHaveBeenCalled()
  })
})
