import { describe, expect, it } from 'vitest'
import {
  normalizeDecodedAudioToWav,
  RecordingAudioError,
} from './audio-processing'

function decodedAudio(channels: Float32Array[], sampleRate: number) {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (channel: number) => channels[channel],
  }
}

function ascii(view: DataView, start: number, length: number) {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(start + index))).join('')
}

describe('microphone audio normalization', () => {
  it('downmixes and resamples browser audio to 16 kHz mono PCM WAV', async () => {
    const sampleRate = 48_000
    const length = sampleRate / 2
    const left = Float32Array.from(
      { length },
      (_, index) => Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.25,
    )
    const right = Float32Array.from(
      { length },
      (_, index) => Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.15,
    )

    const wav = normalizeDecodedAudioToWav(decodedAudio([left, right], sampleRate))
    const view = new DataView(await wav.arrayBuffer())

    expect(wav.type).toBe('audio/wav')
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(16_000)
    expect(wav.size).toBe(44 + 16_000)
  })

  it('rejects a silent or muted microphone before calling Sarvam', () => {
    const silent = decodedAudio([new Float32Array(16_000)], 16_000)

    expect(() => normalizeDecodedAudioToWav(silent)).toThrowError(
      expect.objectContaining<Partial<RecordingAudioError>>({ code: 'audio_too_quiet' }),
    )
  })

  it('rejects clips too short to contain useful speech', () => {
    const click = decodedAudio([Float32Array.from([0, 0.5, 0])], 16_000)

    expect(() => normalizeDecodedAudioToWav(click)).toThrowError(
      expect.objectContaining<Partial<RecordingAudioError>>({ code: 'audio_too_short' }),
    )
  })
})
