import {
  ArrowRight,
  ArrowUpDown,
  Check,
  Copy,
  Globe2,
  Languages,
  LoaderCircle,
  LockKeyhole,
  Mic,
  MonitorSmartphone,
  Moon,
  Square,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  getLanguage,
  LANGUAGES,
  MAX_INPUT_CHARACTERS,
  supportsSarvamTts,
  type LanguageCode,
} from '../shared/languages'
import { BrandMark } from './components/BrandMark'
import { LanguageSelect } from './components/LanguageSelect'
import { normalizeRecordingToWav, RecordingAudioError } from './lib/audio-processing'
import { requestTranslation, TranslationApiError } from './lib/translation-api'
import { requestSpeech, SpeechApiError } from './lib/speech-api'
import { requestTranscription, TranscriptionApiError } from './lib/transcription-api'

type Theme = 'light' | 'dark'
type AudioPhase = 'idle' | 'loading' | 'playing'
type VoiceInputPhase = 'idle' | 'requesting' | 'recording' | 'transcribing'

const MAX_RECORDING_SECONDS = 20
const MAX_TRANSCRIPTION_AUDIO_BYTES = 2 * 1024 * 1024
const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm',
] as const

const EXAMPLES: ReadonlyArray<{ label: string; text: string; target: LanguageCode }> = [
  { label: 'A warm hello', text: 'Hello! It is wonderful to meet you.', target: 'hi' },
  { label: 'Ask for directions', text: 'Could you please show me the way to the railway station?', target: 'ta' },
  { label: 'At the market', text: 'What is the price of these fresh mangoes?', target: 'bn' },
]

function friendlyError(error: unknown): string {
  if (!(error instanceof TranslationApiError)) {
    return 'Something unexpected happened. Your text is safe—please try again.'
  }

  switch (error.code) {
    case 'configuration_error':
      return 'Translation is not configured yet. Add the SARVAM_API_KEY in your Netlify environment variables.'
    case 'rate_limited':
      return 'The translator is receiving many requests. Please wait a moment and try again.'
    case 'provider_unavailable':
      return 'The translation service is temporarily unavailable. Please try again shortly.'
    default:
      return error.message
  }
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access is blocked. Allow Microphone for this site in your browser settings, then try again.'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found. Connect or enable a microphone, then try again.'
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Your microphone is busy or unavailable. Close other apps using it, then try again.'
      case 'OverconstrainedError':
        return 'This microphone could not use the requested recording settings. Try another input device.'
      case 'AbortError':
        return 'Microphone access was interrupted. Please try again.'
    }
  }

  return 'Voice input could not start. Check your browser microphone permission and try again.'
}

function transcriptionErrorMessage(error: unknown): string {
  if (!(error instanceof TranscriptionApiError)) {
    return 'Speech could not be converted to text. Please try again.'
  }

  switch (error.code) {
    case 'configuration_error':
      return 'Speech recognition needs a valid SARVAM_API_KEY.'
    case 'rate_limited':
      return 'Voice recognition is busy. Please wait a moment and try again.'
    case 'provider_unavailable':
    case 'network_error':
      return 'The speech recognition service could not be reached. Please try again.'
    case 'provider_timeout':
      return 'Speech recognition took too long. Please try a shorter clip.'
    case 'no_speech':
    case 'empty_audio':
      return 'No speech was detected. Move closer to the microphone and try again.'
    case 'audio_too_large':
      return 'The recording is too large. Please record a shorter clip.'
    case 'unsupported_audio':
      return 'This browser recorded an unsupported audio format. Try current Chrome, Edge, or Safari.'
    case 'invalid_audio':
    case 'provider_rejected_request':
      return 'The recording could not be recognized. Check that Chrome is using the correct microphone, then try again.'
    default:
      return error.message
  }
}

function recordingAudioErrorMessage(error: RecordingAudioError): string {
  switch (error.code) {
    case 'audio_too_quiet':
      return 'We could barely hear any audio. Check that the selected microphone is not muted, move closer, and try again.'
    case 'audio_too_short':
      return 'The recording was too short. Speak for at least a moment, then press Stop.'
    case 'processing_unavailable':
      return 'This browser cannot prepare microphone audio. Try current Chrome, Edge, or Safari.'
    default:
      return 'The microphone recording could not be read. Please record it again.'
  }
}

function selectRecordingMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }

  return RECORDING_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

function App() {
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>(DEFAULT_SOURCE_LANGUAGE)
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>(DEFAULT_TARGET_LANGUAGE)
  const [sourceText, setSourceText] = useState('')
  const [translation, setTranslation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [voiceInputPhase, setVoiceInputPhase] = useState<VoiceInputPhase>('idle')
  const [speechMessage, setSpeechMessage] = useState<string | null>(null)
  const [audioPhase, setAudioPhase] = useState<AudioPhase>('idle')
  const [audioMessage, setAudioMessage] = useState<string | null>(null)
  const [deviceVoices, setDeviceVoices] = useState<SpeechSynthesisVoice[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [isSwapping, setIsSwapping] = useState(false)
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  const requestController = useRef<AbortController | null>(null)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const microphoneStream = useRef<MediaStream | null>(null)
  const recordingChunks = useRef<Blob[]>([])
  const recordingTimer = useRef<number | null>(null)
  const transcriptionController = useRef<AbortController | null>(null)
  const voiceInputSession = useRef(0)
  const speechRequestController = useRef<AbortController | null>(null)
  const audioElement = useRef<HTMLAudioElement | null>(null)
  const audioObjectUrl = useRef<string | null>(null)
  const activeUtterance = useRef<SpeechSynthesisUtterance | null>(null)
  const toastTimer = useRef<number | null>(null)

  const source = getLanguage(sourceLanguage)
  const target = getLanguage(targetLanguage)
  const voiceInputSupported = Boolean(
    window.isSecureContext !== false
      && typeof navigator.mediaDevices?.getUserMedia === 'function'
      && typeof MediaRecorder !== 'undefined',
  )
  const isListening = voiceInputPhase === 'recording'
  const isVoiceInputActive = voiceInputPhase !== 'idle'
  const speechSynthesisSupported = 'speechSynthesis' in window
  const cloudVoiceAvailable = supportsSarvamTts(targetLanguage)
  const matchingDeviceVoice = deviceVoices.find(
    (voice) => voice.lang.toLowerCase() === target.speechLocale.toLowerCase(),
  ) ?? deviceVoices.find((voice) => {
    const targetPrefix = target.speechLocale.split('-')[0].toLowerCase()
    return voice.lang.toLowerCase().split('-')[0] === targetPrefix
  })
  const remainingCharacters = MAX_INPUT_CHARACTERS - sourceText.length
  const voiceButtonLabel = voiceInputPhase === 'recording'
    ? 'Stop listening'
    : isVoiceInputActive
      ? 'Cancel voice input'
      : `Speak in ${source.name}`
  const voiceButtonText = voiceInputPhase === 'recording'
    ? 'Stop'
    : isVoiceInputActive
      ? 'Cancel'
      : 'Speak'

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      requestController.current?.abort()
      cancelVoiceInput(null, false)
      speechRequestController.current?.abort()
      audioElement.current?.pause()
      if (audioObjectUrl.current) URL.revokeObjectURL(audioObjectUrl.current)
      activeUtterance.current = null
      window.speechSynthesis?.cancel()
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!speechSynthesisSupported) return

    const refreshVoices = () => setDeviceVoices(window.speechSynthesis.getVoices())
    refreshVoices()
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)

    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
  }, [speechSynthesisSupported])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('language-connect-theme', theme)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#000000' : '#f2f2f7')
  }, [theme])

  function showToast(message: string) {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }

  function clearResultState() {
    stopSpeaking()
    setTranslation('')
    setError(null)
  }

  function clearRecordingTimer() {
    if (recordingTimer.current !== null) {
      window.clearTimeout(recordingTimer.current)
      recordingTimer.current = null
    }
  }

  function cancelVoiceInput(message: string | null = null, updateState = true) {
    voiceInputSession.current += 1
    clearRecordingTimer()
    transcriptionController.current?.abort()
    transcriptionController.current = null

    const activeRecorder = mediaRecorder.current
    mediaRecorder.current = null
    if (activeRecorder) {
      activeRecorder.ondataavailable = null
      activeRecorder.onerror = null
      activeRecorder.onstart = null
      activeRecorder.onstop = null
      if (activeRecorder.state !== 'inactive') {
        try {
          activeRecorder.stop()
        } catch {
          // The browser may already be closing the recorder.
        }
      }
    }

    stopMediaStream(microphoneStream.current)
    microphoneStream.current = null
    recordingChunks.current = []

    if (updateState) {
      setVoiceInputPhase('idle')
      setSpeechMessage(message)
    }
  }

  function updateSourceLanguage(nextLanguage: LanguageCode) {
    if (nextLanguage !== sourceLanguage) cancelVoiceInput()
    if (nextLanguage === targetLanguage) setTargetLanguage(sourceLanguage)
    setSourceLanguage(nextLanguage)
    clearResultState()
    setSpeechMessage(null)
  }

  function updateTargetLanguage(nextLanguage: LanguageCode) {
    if (nextLanguage === sourceLanguage) cancelVoiceInput()
    if (nextLanguage === sourceLanguage) setSourceLanguage(targetLanguage)
    setTargetLanguage(nextLanguage)
    clearResultState()
  }

  function updateSourceText(value: string) {
    setSourceText(value)
    clearResultState()
  }

  function swapLanguages() {
    requestController.current?.abort()
    cancelVoiceInput()
    stopSpeaking()
    setIsSwapping(true)
    window.setTimeout(() => setIsSwapping(false), 260)

    setSourceLanguage(targetLanguage)
    setTargetLanguage(sourceLanguage)

    if (translation) {
      setSourceText(translation)
      setTranslation('')
    }

    setError(null)
    setSpeechMessage(null)
  }

  async function translate(event?: FormEvent) {
    event?.preventDefault()
    const cleanText = sourceText.trim()

    if (isVoiceInputActive) {
      setError('Finish or cancel voice input before translating.')
      return
    }

    if (!cleanText) {
      setError('Enter some text to translate.')
      return
    }

    if (!isOnline) {
      setError('You are offline. Reconnect and try again.')
      return
    }

    if (sourceLanguage === targetLanguage) {
      setError('Choose two different languages.')
      return
    }

    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setIsLoading(true)
    setError(null)
    setSpeechMessage(null)
    stopSpeaking()

    try {
      const response = await requestTranslation(
        cleanText,
        sourceLanguage,
        targetLanguage,
        controller.signal,
      )
      setTranslation(response.translation)
    } catch (caughtError) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return
      setError(friendlyError(caughtError))
    } finally {
      if (requestController.current === controller) {
        setIsLoading(false)
        requestController.current = null
      }
    }
  }

  async function transcribeRecording(
    instance: MediaRecorder,
    stream: MediaStream,
    chunks: Blob[],
    session: number,
    preferredMimeType: string,
  ) {
    clearRecordingTimer()
    if (mediaRecorder.current === instance) mediaRecorder.current = null
    if (microphoneStream.current === stream) microphoneStream.current = null
    stopMediaStream(stream)

    if (voiceInputSession.current !== session) return

    const mimeType = instance.mimeType || chunks.find((chunk) => chunk.type)?.type || preferredMimeType
    const baseMimeType = mimeType.split(';', 1)[0].toLowerCase()
    if (!['audio/webm', 'audio/mp4', 'audio/ogg', 'video/webm', 'video/mp4'].includes(baseMimeType)) {
      setVoiceInputPhase('idle')
      setSpeechMessage('This browser recorded an unsupported audio format. Try current Chrome, Edge, or Safari.')
      return
    }

    const audio = new Blob(chunks, { type: mimeType })
    recordingChunks.current = []
    if (!audio.size) {
      setVoiceInputPhase('idle')
      setSpeechMessage('No audio was captured. Check your microphone and try again.')
      return
    }

    if (audio.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      setVoiceInputPhase('idle')
      setSpeechMessage('The recording is too large. Please record a shorter clip.')
      return
    }

    if (!navigator.onLine) {
      setVoiceInputPhase('idle')
      setSpeechMessage('You are offline. Reconnect and try voice input again.')
      return
    }

    const controller = new AbortController()
    transcriptionController.current = controller
    setVoiceInputPhase('transcribing')
    setSpeechMessage('Checking and preparing the microphone audio…')

    try {
      const normalizedAudio = await normalizeRecordingToWav(audio, controller.signal)
      if (voiceInputSession.current !== session || transcriptionController.current !== controller) return
      setSpeechMessage(`Converting ${source.name} speech to text…`)
      const response = await requestTranscription(
        normalizedAudio,
        'recording.wav',
        sourceLanguage,
        controller.signal,
      )
      if (voiceInputSession.current !== session || transcriptionController.current !== controller) return

      stopSpeaking()
      setTranslation('')
      setError(null)
      setSourceText((currentText) => {
        const spacer = currentText && !currentText.endsWith(' ') ? ' ' : ''
        return `${currentText}${spacer}${response.transcript}`.slice(0, MAX_INPUT_CHARACTERS)
      })
      setSpeechMessage('Voice input added.')
    } catch (caughtError) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return
      if (voiceInputSession.current !== session) return
      setSpeechMessage(
        caughtError instanceof RecordingAudioError
          ? recordingAudioErrorMessage(caughtError)
          : transcriptionErrorMessage(caughtError),
      )
    } finally {
      if (voiceInputSession.current === session && transcriptionController.current === controller) {
        transcriptionController.current = null
        setVoiceInputPhase('idle')
      }
    }
  }

  function stopActiveRecording() {
    const instance = mediaRecorder.current
    if (!instance || instance.state === 'inactive') {
      cancelVoiceInput('No active recording was found. Please try again.')
      return
    }

    clearRecordingTimer()
    setVoiceInputPhase('transcribing')
    setSpeechMessage('Preparing your recording…')
    try {
      instance.stop()
    } catch {
      cancelVoiceInput('The recording could not be finished. Please try again.')
    }
  }

  async function beginVoiceInput() {
    if (window.isSecureContext === false) {
      setSpeechMessage('Voice input needs a secure page. Open this app on HTTPS or localhost and try again.')
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSpeechMessage('Voice input is not supported in this browser. You can still type or paste text.')
      return
    }

    if (!navigator.onLine) {
      setSpeechMessage('You are offline. Reconnect and try voice input again.')
      return
    }

    if (sourceText.length >= MAX_INPUT_CHARACTERS) {
      setSpeechMessage('The text box is full. Clear some text before using voice input.')
      return
    }

    const session = voiceInputSession.current + 1
    voiceInputSession.current = session
    setVoiceInputPhase('requesting')
    setSpeechMessage('Waiting for microphone access…')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
    } catch (caughtError) {
      if (voiceInputSession.current !== session) return
      setVoiceInputPhase('idle')
      setSpeechMessage(microphoneErrorMessage(caughtError))
      return
    }

    if (voiceInputSession.current !== session) {
      stopMediaStream(stream)
      return
    }

    const preferredMimeType = selectRecordingMimeType()
    let instance: MediaRecorder
    try {
      const options: MediaRecorderOptions = {
        audioBitsPerSecond: 64_000,
        ...(preferredMimeType ? { mimeType: preferredMimeType } : {}),
      }
      try {
        instance = new MediaRecorder(stream, options)
      } catch {
        instance = new MediaRecorder(
          stream,
          preferredMimeType ? { mimeType: preferredMimeType } : undefined,
        )
      }
    } catch (caughtError) {
      stopMediaStream(stream)
      if (voiceInputSession.current !== session) return
      setVoiceInputPhase('idle')
      setSpeechMessage(microphoneErrorMessage(caughtError))
      return
    }

    const chunks: Blob[] = []
    microphoneStream.current = stream
    mediaRecorder.current = instance
    recordingChunks.current = chunks
    instance.ondataavailable = (event) => {
      if (voiceInputSession.current === session && event.data.size) chunks.push(event.data)
    }
    instance.onerror = () => {
      if (voiceInputSession.current !== session) return
      cancelVoiceInput('Microphone recording stopped unexpectedly. Please try again.')
    }
    instance.onstart = () => {
      if (voiceInputSession.current !== session) return
      setVoiceInputPhase('recording')
      setSpeechMessage(
        `Listening in ${source.name}… Speak for at least one second, then press Stop (maximum ${MAX_RECORDING_SECONDS} seconds).`,
      )
      recordingTimer.current = window.setTimeout(() => {
        if (voiceInputSession.current === session) stopActiveRecording()
      }, MAX_RECORDING_SECONDS * 1000)
    }
    instance.onstop = () => {
      void transcribeRecording(instance, stream, chunks, session, preferredMimeType)
    }

    try {
      // A single complete recording gives WebM/MP4 encoders time to finalize
      // their container metadata before the final dataavailable event.
      instance.start()
    } catch (caughtError) {
      cancelVoiceInput(microphoneErrorMessage(caughtError))
    }
  }

  function toggleVoiceInput() {
    if (voiceInputPhase === 'recording') {
      stopActiveRecording()
    } else if (voiceInputPhase === 'requesting' || voiceInputPhase === 'transcribing') {
      cancelVoiceInput('Voice input cancelled.')
    } else {
      void beginVoiceInput()
    }
  }

  function stopSpeaking(message: string | null = null) {
    speechRequestController.current?.abort()
    speechRequestController.current = null

    if (audioElement.current) {
      audioElement.current.pause()
      audioElement.current.removeAttribute('src')
      audioElement.current = null
    }

    if (audioObjectUrl.current) {
      URL.revokeObjectURL(audioObjectUrl.current)
      audioObjectUrl.current = null
    }

    window.speechSynthesis?.cancel()
    activeUtterance.current = null
    setAudioPhase('idle')
    setAudioMessage(message)
  }

  function playWithDeviceVoice(voice: SpeechSynthesisVoice) {
    const utterance = new SpeechSynthesisUtterance(translation)
    utterance.lang = target.speechLocale
    utterance.voice = voice
    utterance.rate = 0.92
    utterance.onstart = () => {
      setAudioPhase('playing')
      setAudioMessage(`Playing the ${target.name} voice from this device…`)
    }
    utterance.onend = () => {
      activeUtterance.current = null
      setAudioPhase('idle')
      setAudioMessage(`${target.name} playback finished.`)
    }
    utterance.onerror = () => {
      activeUtterance.current = null
      setAudioPhase('idle')
      setAudioMessage(`The ${target.name} device voice could not be played.`)
    }

    activeUtterance.current = utterance
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  async function speakTranslation() {
    if (!translation) return

    if (audioPhase !== 'idle') {
      stopSpeaking('Playback stopped.')
      return
    }

    if (!cloudVoiceAvailable) {
      if (speechSynthesisSupported && matchingDeviceVoice) {
        playWithDeviceVoice(matchingDeviceVoice)
      } else {
        setAudioMessage(
          `${target.name} voice is not available from Sarvam or on this device. Translation still works.`,
        )
      }
      return
    }

    const controller = new AbortController()
    speechRequestController.current = controller
    setAudioPhase('loading')
    setAudioMessage(`Preparing a natural ${target.name} voice…`)

    try {
      const audioBlob = await requestSpeech(translation, targetLanguage, controller.signal)
      if (speechRequestController.current !== controller) return
      speechRequestController.current = null

      const objectUrl = URL.createObjectURL(audioBlob)
      const player = new Audio(objectUrl)
      audioObjectUrl.current = objectUrl
      audioElement.current = player
      player.preload = 'auto'
      player.onplaying = () => {
        setAudioPhase('playing')
        setAudioMessage(`Playing a natural ${target.name} voice…`)
      }
      player.onended = () => stopSpeaking(`${target.name} playback finished.`)
      player.onerror = () => stopSpeaking(`The ${target.name} audio could not be played.`)

      await player.play()
    } catch (caughtError) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return

      speechRequestController.current = null
      setAudioPhase('idle')

      if (matchingDeviceVoice && speechSynthesisSupported) {
        setAudioMessage('Cloud voice was unavailable, so this device voice is being used instead.')
        playWithDeviceVoice(matchingDeviceVoice)
        return
      }

      const message =
        caughtError instanceof SpeechApiError && caughtError.code === 'rate_limited'
          ? 'Voice generation is busy. Please wait a moment and try again.'
          : caughtError instanceof SpeechApiError && caughtError.code === 'configuration_error'
            ? 'Voice generation needs a valid SARVAM_API_KEY.'
            : `The ${target.name} voice could not be generated. Please try again.`
      setAudioMessage(message)
    }
  }

  async function copyTranslation() {
    if (!translation) return

    try {
      await navigator.clipboard.writeText(translation)
      showToast('Translation copied')
    } catch {
      showToast('Copy was blocked by your browser')
    }
  }

  function useExample(example: (typeof EXAMPLES)[number]) {
    cancelVoiceInput()
    stopSpeaking()
    setSourceLanguage('en')
    setTargetLanguage(example.target)
    setSourceText(example.text)
    setTranslation('')
    setError(null)
    document.querySelector<HTMLTextAreaElement>('#source-text')?.focus()
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient--one" aria-hidden="true" />
      <div className="ambient ambient--two" aria-hidden="true" />

      {!isOnline && (
        <div className="offline-banner" role="status">
          <WifiOff size={16} aria-hidden="true" />
          You are offline. Translation will be ready when your connection returns.
        </div>
      )}

      <header className="site-header">
        <a className="brand" href="#top" aria-label="Language Connect AI home">
          <BrandMark />
          <span className="brand__copy">
            <strong>Language Connect</strong>
            <span>AI</span>
          </span>
        </a>

        <div className="header-actions">
          <span className="language-count">
            <Globe2 size={16} aria-hidden="true" />
            23 languages
          </span>
          <button
            className="icon-button theme-toggle"
            type="button"
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="eyebrow reveal reveal--one">
            <Sparkles size={15} aria-hidden="true" />
            Built for the languages of India
          </div>
          <h1 id="hero-heading" className="reveal reveal--two">
            Every voice, <em>closer.</em>
          </h1>
          <p className="hero__intro reveal reveal--three">
            Translate naturally between English and India&apos;s 22 scheduled languages—on any screen,
            in just a few taps.
          </p>
        </section>

        <section className="translator-section reveal reveal--four" aria-label="Translator">
          <form
            className="translator-card"
            onSubmit={translate}
            aria-busy={isLoading || voiceInputPhase === 'transcribing'}
          >
            <div className="language-bar">
              <LanguageSelect
                id="source-language"
                label="Translate from"
                value={sourceLanguage}
                onChange={updateSourceLanguage}
              />

              <button
                type="button"
                className={`swap-button${isSwapping ? ' is-swapping' : ''}`}
                onClick={swapLanguages}
                aria-label={`Swap ${source.name} and ${target.name}`}
              >
                <ArrowUpDown size={20} aria-hidden="true" />
              </button>

              <LanguageSelect
                id="target-language"
                label="Translate to"
                value={targetLanguage}
                onChange={updateTargetLanguage}
              />
            </div>

            <div className="workspace-grid">
              <div className="text-panel text-panel--source">
                <div className="panel-heading">
                  <label htmlFor="source-text">Text to translate</label>
                  <div className="panel-tools">
                    {sourceText && (
                      <button
                        type="button"
                        className="tool-button"
                        onClick={() => updateSourceText('')}
                        aria-label="Clear source text"
                      >
                        <Trash2 size={17} aria-hidden="true" />
                        <span>Clear</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={`tool-button mic-button${isListening ? ' is-listening' : ''}`}
                      onClick={toggleVoiceInput}
                      disabled={isLoading}
                      aria-label={voiceButtonLabel}
                      title={
                        voiceInputSupported
                          ? `Speak in ${source.name}`
                          : 'Voice input is not available in this browser'
                      }
                    >
                      {voiceInputPhase === 'requesting' || voiceInputPhase === 'transcribing' ? (
                        <LoaderCircle className="spin" size={17} aria-hidden="true" />
                      ) : isListening ? (
                        <X size={17} aria-hidden="true" />
                      ) : (
                        <Mic size={17} aria-hidden="true" />
                      )}
                      <span>{voiceButtonText}</span>
                    </button>
                  </div>
                </div>

                <textarea
                  id="source-text"
                  className="source-input"
                  value={sourceText}
                  onChange={(event) => updateSourceText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void translate()
                  }}
                  maxLength={MAX_INPUT_CHARACTERS}
                  rows={6}
                  lang={source.code}
                  dir={source.direction}
                  placeholder={`Type or paste ${source.name} text here…`}
                  aria-describedby="character-count speech-message"
                />

                <div className="panel-footer">
                  <span id="speech-message" className="speech-message" role="status">
                    {isListening && <span className="listening-dot" aria-hidden="true" />}
                    {speechMessage}
                  </span>
                  <span
                    id="character-count"
                    className={`character-count${remainingCharacters < 160 ? ' is-near-limit' : ''}`}
                  >
                    {sourceText.length.toLocaleString('en-IN')} / {MAX_INPUT_CHARACTERS.toLocaleString('en-IN')}
                  </span>
                </div>
              </div>

              <div className="text-panel text-panel--result">
                <div className="panel-heading">
                  <span id="result-label">Translation</span>
                  <div className="panel-tools">
                    <button
                      type="button"
                      className={`tool-button${audioPhase !== 'idle' ? ' is-playing' : ''}`}
                      onClick={() => void speakTranslation()}
                      disabled={!translation || isLoading}
                      aria-label={
                        audioPhase === 'idle'
                          ? `Listen to ${target.name} translation`
                          : `Stop ${target.name} playback`
                      }
                      title={
                        cloudVoiceAvailable
                          ? `Play a natural ${target.name} voice`
                          : matchingDeviceVoice
                            ? `Play the installed ${target.name} device voice`
                            : `${target.name} voice is not installed on this device`
                      }
                    >
                      {audioPhase === 'loading' ? (
                        <LoaderCircle className="spin" size={17} aria-hidden="true" />
                      ) : audioPhase === 'playing' ? (
                        <Square size={15} aria-hidden="true" />
                      ) : (
                        <Volume2 size={17} aria-hidden="true" />
                      )}
                      <span>{audioPhase === 'idle' ? 'Listen' : 'Stop'}</span>
                    </button>
                    <button
                      type="button"
                      className="tool-button"
                      onClick={copyTranslation}
                      disabled={!translation || isLoading}
                      aria-label="Copy translation"
                    >
                      <Copy size={17} aria-hidden="true" />
                      <span>Copy</span>
                    </button>
                  </div>
                </div>

                <div
                  className={`result-content${translation ? ' has-translation' : ''}`}
                  aria-labelledby="result-label"
                  aria-live="polite"
                  aria-atomic="true"
                  lang={target.code}
                  dir={target.direction}
                >
                  {isLoading ? (
                    <div className="translation-loading" role="status">
                      <div className="loading-orb" aria-hidden="true">
                        <Languages size={23} />
                      </div>
                      <div>
                        <strong>Translating into {target.name}</strong>
                        <span>Finding the clearest way to say it…</span>
                      </div>
                      <div className="skeleton-lines" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  ) : translation ? (
                    <p className="translated-text">{translation}</p>
                  ) : (
                    <div className="empty-result" dir="ltr">
                      <div className="empty-result__visual" aria-hidden="true">
                        <span>अ</span>
                        <ArrowRight size={18} />
                        <span>அ</span>
                      </div>
                      <strong>Your translation will appear here</strong>
                      <span>Choose your languages, add text, and let the words travel.</span>
                    </div>
                  )}
                </div>

                <div className="panel-footer panel-footer--result">
                  <span className="audio-status" aria-live="polite">
                    {audioMessage ?? 'Formal translation'}
                  </span>
                  {translation && audioPhase === 'idle' && (
                    <span className="ready-label">
                      <Check size={14} aria-hidden="true" /> Ready
                    </span>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <div className="error-message" role="alert">
                <span className="error-message__icon">!</span>
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                  <X size={17} />
                </button>
              </div>
            )}

            <div className="translator-actions">
              <p>
                <LockKeyhole size={15} aria-hidden="true" />
                Your translation key stays securely on the server.
              </p>
              <button
                className="translate-button"
                type="submit"
                disabled={
                  isLoading
                  || isVoiceInputActive
                  || !sourceText.trim()
                  || sourceLanguage === targetLanguage
                }
              >
                {isLoading ? (
                  <>
                    <LoaderCircle className="spin" size={20} aria-hidden="true" />
                    Translating…
                  </>
                ) : (
                  <>
                    Translate to {target.name}
                    <ArrowRight size={20} aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="example-row" aria-label="Try an example">
            <span>Need a starting point?</span>
            <div>
              {EXAMPLES.map((example) => (
                <button key={example.label} type="button" onClick={() => useExample(example)}>
                  {example.label}
                </button>
              ))}
            </div>
          </div>

          <div className="capability-rail" aria-label="Language Connect highlights">
            <span>English + 22 scheduled languages</span>
            <span>Private server-side translation</span>
            <span>Natural voice where supported</span>
          </div>
        </section>

        <section className="language-showcase" aria-labelledby="language-heading">
          <div className="section-heading">
            <span>One connected space</span>
            <h2 id="language-heading">23 languages. Millions of conversations.</h2>
            <p>English and every language in the Eighth Schedule of the Constitution of India.</p>
          </div>

          <div className="language-cloud">
            {LANGUAGES.map((language, index) => (
              <span key={language.code} style={{ '--delay': `${index * 18}ms` } as CSSProperties}>
                <b lang={language.code} dir={language.direction}>
                  {language.nativeName}
                </b>
                {language.name !== language.nativeName && <small>{language.name}</small>}
              </span>
            ))}
          </div>
        </section>

        <section className="feature-grid" aria-label="Application features">
          <article className="feature-card feature-card--large">
            <div className="feature-icon feature-icon--purple">
              <Zap size={22} aria-hidden="true" />
            </div>
            <span className="feature-number">01</span>
            <h3>Fast, focused translation</h3>
            <p>Direct language-to-language translation keeps the experience simple and responsive.</p>
            <div className="sound-wave" aria-hidden="true">
              {Array.from({ length: 18 }, (_, index) => (
                <i key={index} />
              ))}
            </div>
          </article>

          <article className="feature-card">
            <div className="feature-icon feature-icon--teal">
              <Mic size={22} aria-hidden="true" />
            </div>
            <span className="feature-number">02</span>
            <h3>Speak and listen</h3>
            <p>Hear natural cloud voices where supported, with an exact device-voice fallback elsewhere.</p>
          </article>

          <article className="feature-card">
            <div className="feature-icon feature-icon--orange">
              <MonitorSmartphone size={22} aria-hidden="true" />
            </div>
            <span className="feature-number">03</span>
            <h3>At home on every screen</h3>
            <p>Accessible controls and fluid layouts work from pocket-sized phones to wide laptops.</p>
          </article>
        </section>

        <aside className="accuracy-note">
          <Sparkles size={18} aria-hidden="true" />
          <p>
            <strong>A thoughtful reminder</strong>
            AI translation can miss context or regional nuance. Verify medical, legal, financial, and other
            important information with a qualified speaker.
          </p>
        </aside>
      </main>

      <footer className="site-footer">
        <div className="brand brand--footer">
          <BrandMark />
          <span className="brand__copy">
            <strong>Language Connect</strong>
            <span>AI</span>
          </span>
        </div>
        <p>Designed to bring India&apos;s languages a little closer.</p>
        <a href="#top">Back to translator</a>
      </footer>

      <div className={`toast${toast ? ' is-visible' : ''}`} role="status" aria-live="polite">
        <Check size={16} aria-hidden="true" />
        {toast}
      </div>

      <div className="sr-only" aria-live="polite">
        {isLoading ? 'Translation in progress.' : translation ? 'Translation ready.' : ''}
      </div>
    </div>
  )
}

export default App
