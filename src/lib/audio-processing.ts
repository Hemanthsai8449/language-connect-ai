export type RecordingAudioErrorCode =
  | 'audio_too_short'
  | 'audio_too_quiet'
  | 'decode_failed'
  | 'processing_unavailable'

export class RecordingAudioError extends Error {
  readonly code: RecordingAudioErrorCode

  constructor(message: string, code: RecordingAudioErrorCode) {
    super(message)
    this.name = 'RecordingAudioError'
    this.code = code
  }
}

type DecodedAudio = Pick<
  AudioBuffer,
  'sampleRate' | 'numberOfChannels' | 'length' | 'getChannelData'
>

const TARGET_SAMPLE_RATE = 16_000
const MINIMUM_DURATION_SECONDS = 0.2
const MINIMUM_PEAK = 0.002
const MINIMUM_RMS = 0.00035

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Audio processing was cancelled.', 'AbortError')
}

function downmixToMono(audio: DecodedAudio): Float32Array {
  const mono = new Float32Array(audio.length)
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const samples = audio.getChannelData(channel)
    for (let index = 0; index < audio.length; index += 1) {
      mono[index] += (samples[index] ?? 0) / audio.numberOfChannels
    }
  }

  // Remove a constant DC offset so a faulty input cannot look like audible speech.
  let mean = 0
  for (const sample of mono) mean += sample
  mean /= Math.max(mono.length, 1)
  if (mean) {
    for (let index = 0; index < mono.length; index += 1) mono[index] -= mean
  }

  return mono
}

function ensureAudibleSignal(samples: Float32Array) {
  let peak = 0
  let squaredTotal = 0
  for (const sample of samples) {
    const absolute = Math.abs(sample)
    if (absolute > peak) peak = absolute
    squaredTotal += sample * sample
  }

  const rms = Math.sqrt(squaredTotal / Math.max(samples.length, 1))
  if (peak < MINIMUM_PEAK || rms < MINIMUM_RMS) {
    throw new RecordingAudioError(
      'The recording was silent or too quiet to recognize.',
      'audio_too_quiet',
    )
  }
}

function resampleLinear(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (sourceSampleRate === targetSampleRate) return samples

  const targetLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate))
  const result = new Float32Array(targetLength)
  const ratio = sourceSampleRate / targetSampleRate

  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * ratio
    const lowerIndex = Math.floor(sourcePosition)
    const upperIndex = Math.min(lowerIndex + 1, samples.length - 1)
    const fraction = sourcePosition - lowerIndex
    const lower = samples[lowerIndex] ?? 0
    result[index] = lower + ((samples[upperIndex] ?? lower) - lower) * fraction
  }

  return result
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function encodePcm16Wav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export function normalizeDecodedAudioToWav(audio: DecodedAudio): Blob {
  if (
    !Number.isFinite(audio.sampleRate)
    || audio.sampleRate <= 0
    || audio.numberOfChannels <= 0
    || audio.length / audio.sampleRate < MINIMUM_DURATION_SECONDS
  ) {
    throw new RecordingAudioError(
      'The recording was too short to recognize.',
      'audio_too_short',
    )
  }

  const mono = downmixToMono(audio)
  ensureAudibleSignal(mono)
  return encodePcm16Wav(resampleLinear(mono, audio.sampleRate, TARGET_SAMPLE_RATE))
}

export async function normalizeRecordingToWav(audio: Blob, signal?: AbortSignal): Promise<Blob> {
  throwIfAborted(signal)
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextClass) {
    throw new RecordingAudioError(
      'This browser cannot prepare microphone audio for recognition.',
      'processing_unavailable',
    )
  }

  let context: AudioContext | null = null
  try {
    context = new AudioContextClass()
    const encodedAudio = await audio.arrayBuffer()
    throwIfAborted(signal)
    const decodedAudio = await context.decodeAudioData(encodedAudio.slice(0))
    throwIfAborted(signal)
    return normalizeDecodedAudioToWav(decodedAudio)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof RecordingAudioError) throw error
    throw new RecordingAudioError(
      'The browser could not read the microphone recording.',
      'decode_failed',
    )
  } finally {
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
  }
}
