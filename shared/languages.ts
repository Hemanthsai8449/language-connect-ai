export type TextDirection = 'ltr' | 'rtl'

export interface Language {
  code: string
  providerCode: string
  name: string
  nativeName: string
  speechLocale: string
  direction: TextDirection
}

export const LANGUAGES = [
  { code: 'en', providerCode: 'en-IN', name: 'English', nativeName: 'English', speechLocale: 'en-IN', direction: 'ltr' },
  { code: 'as', providerCode: 'as-IN', name: 'Assamese', nativeName: 'অসমীয়া', speechLocale: 'as-IN', direction: 'ltr' },
  { code: 'bn', providerCode: 'bn-IN', name: 'Bengali', nativeName: 'বাংলা', speechLocale: 'bn-IN', direction: 'ltr' },
  { code: 'brx', providerCode: 'brx-IN', name: 'Bodo', nativeName: 'बड़ो', speechLocale: 'brx-IN', direction: 'ltr' },
  { code: 'doi', providerCode: 'doi-IN', name: 'Dogri', nativeName: 'डोगरी', speechLocale: 'doi-IN', direction: 'ltr' },
  { code: 'gu', providerCode: 'gu-IN', name: 'Gujarati', nativeName: 'ગુજરાતી', speechLocale: 'gu-IN', direction: 'ltr' },
  { code: 'hi', providerCode: 'hi-IN', name: 'Hindi', nativeName: 'हिन्दी', speechLocale: 'hi-IN', direction: 'ltr' },
  { code: 'kn', providerCode: 'kn-IN', name: 'Kannada', nativeName: 'ಕನ್ನಡ', speechLocale: 'kn-IN', direction: 'ltr' },
  { code: 'ks', providerCode: 'ks-IN', name: 'Kashmiri', nativeName: 'کٲشُر', speechLocale: 'ks-IN', direction: 'rtl' },
  { code: 'kok', providerCode: 'kok-IN', name: 'Konkani', nativeName: 'कोंकणी', speechLocale: 'kok-IN', direction: 'ltr' },
  { code: 'mai', providerCode: 'mai-IN', name: 'Maithili', nativeName: 'मैथिली', speechLocale: 'mai-IN', direction: 'ltr' },
  { code: 'ml', providerCode: 'ml-IN', name: 'Malayalam', nativeName: 'മലയാളം', speechLocale: 'ml-IN', direction: 'ltr' },
  { code: 'mni', providerCode: 'mni-IN', name: 'Manipuri', nativeName: 'ꯃꯤꯇꯩ ꯂꯣꯟ', speechLocale: 'mni-IN', direction: 'ltr' },
  { code: 'mr', providerCode: 'mr-IN', name: 'Marathi', nativeName: 'मराठी', speechLocale: 'mr-IN', direction: 'ltr' },
  { code: 'ne', providerCode: 'ne-IN', name: 'Nepali', nativeName: 'नेपाली', speechLocale: 'ne-IN', direction: 'ltr' },
  { code: 'or', providerCode: 'od-IN', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', speechLocale: 'or-IN', direction: 'ltr' },
  { code: 'pa', providerCode: 'pa-IN', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', speechLocale: 'pa-IN', direction: 'ltr' },
  { code: 'sa', providerCode: 'sa-IN', name: 'Sanskrit', nativeName: 'संस्कृतम्', speechLocale: 'sa-IN', direction: 'ltr' },
  { code: 'sat', providerCode: 'sat-IN', name: 'Santali', nativeName: 'ᱥᱟᱱᱛᱟᱲᱤ', speechLocale: 'sat-IN', direction: 'ltr' },
  { code: 'sd', providerCode: 'sd-IN', name: 'Sindhi', nativeName: 'سنڌي', speechLocale: 'sd-IN', direction: 'rtl' },
  { code: 'ta', providerCode: 'ta-IN', name: 'Tamil', nativeName: 'தமிழ்', speechLocale: 'ta-IN', direction: 'ltr' },
  { code: 'te', providerCode: 'te-IN', name: 'Telugu', nativeName: 'తెలుగు', speechLocale: 'te-IN', direction: 'ltr' },
  { code: 'ur', providerCode: 'ur-IN', name: 'Urdu', nativeName: 'اردو', speechLocale: 'ur-IN', direction: 'rtl' },
] as const satisfies readonly Language[]

export const MAX_INPUT_CHARACTERS = 2000

export type LanguageCode = (typeof LANGUAGES)[number]['code']

export const SARVAM_TTS_LANGUAGE_CODES = [
  'en',
  'hi',
  'bn',
  'ta',
  'te',
  'kn',
  'ml',
  'mr',
  'gu',
  'pa',
  'or',
] as const satisfies readonly LanguageCode[]

export type SarvamTtsLanguageCode = (typeof SARVAM_TTS_LANGUAGE_CODES)[number]

export const DEFAULT_SOURCE_LANGUAGE: LanguageCode = 'en'
export const DEFAULT_TARGET_LANGUAGE: LanguageCode = 'hi'

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
}

export function supportsSarvamTts(code: LanguageCode): code is SarvamTtsLanguageCode {
  return (SARVAM_TTS_LANGUAGE_CODES as readonly LanguageCode[]).includes(code)
}

export function getLanguage(code: LanguageCode): (typeof LANGUAGES)[number] {
  const language = LANGUAGES.find((item) => item.code === code)

  if (!language) {
    throw new Error(`Unsupported language code: ${code}`)
  }

  return language
}
