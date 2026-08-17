import '@testing-library/jest-dom/vitest'

const speechSynthesis = Object.assign(new EventTarget(), {
  cancel: () => undefined,
  speak: () => undefined,
  getVoices: () => [] as SpeechSynthesisVoice[],
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

Object.defineProperty(window, 'speechSynthesis', {
  configurable: true,
  value: speechSynthesis,
})

Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: () => 'blob:mock-audio',
})

Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  value: () => undefined,
})

Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: async () => undefined,
})

Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: () => undefined,
})

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async () => undefined },
})
