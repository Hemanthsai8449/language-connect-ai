import { describe, expect, it } from 'vitest'
import {
  getLanguage,
  isLanguageCode,
  LANGUAGES,
  SARVAM_TTS_LANGUAGE_CODES,
  supportsSarvamTts,
} from './languages'

describe('Indian language allowlist', () => {
  it('contains English and exactly 22 scheduled Indian languages', () => {
    expect(LANGUAGES).toHaveLength(23)
    expect(LANGUAGES[0].code).toBe('en')
    expect(new Set(LANGUAGES.map((language) => language.code)).size).toBe(23)
    expect(new Set(LANGUAGES.map((language) => language.providerCode)).size).toBe(23)
  })

  it('rejects languages outside the product scope', () => {
    expect(isLanguageCode('hi')).toBe(true)
    expect(isLanguageCode('fr')).toBe(false)
    expect(isLanguageCode('zh')).toBe(false)
  })

  it('maps Odia to the provider-specific language code', () => {
    expect(getLanguage('or').providerCode).toBe('od-IN')
  })

  it('marks Perso-Arabic scripts as right-to-left', () => {
    expect(getLanguage('ur').direction).toBe('rtl')
    expect(getLanguage('sd').direction).toBe('rtl')
    expect(getLanguage('ks').direction).toBe('rtl')
  })

  it('keeps cloud speech restricted to Bulbul-supported languages', () => {
    expect(SARVAM_TTS_LANGUAGE_CODES).toHaveLength(11)
    expect(supportsSarvamTts('ta')).toBe(true)
    expect(supportsSarvamTts('or')).toBe(true)
    expect(supportsSarvamTts('as')).toBe(false)
    expect(supportsSarvamTts('ur')).toBe(false)
  })
})
