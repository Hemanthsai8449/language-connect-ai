import { ChevronDown } from 'lucide-react'
import { LANGUAGES, type LanguageCode } from '../../shared/languages'

interface LanguageSelectProps {
  id: string
  label: string
  value: LanguageCode
  onChange: (language: LanguageCode) => void
}

export function LanguageSelect({ id, label, value, onChange }: LanguageSelectProps) {
  const selectedLanguage = LANGUAGES.find((language) => language.code === value)!

  return (
    <label className="language-select" htmlFor={id}>
      <span className="language-select__label">{label}</span>
      <span className="language-select__control">
        <span className="language-select__value">
          <span
            className="language-select__native"
            lang={selectedLanguage.code}
            dir={selectedLanguage.direction}
          >
            {selectedLanguage.nativeName}
          </span>
          <span className="language-select__english">{selectedLanguage.name}</span>
        </span>
        <ChevronDown aria-hidden="true" size={18} strokeWidth={2.2} />
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value as LanguageCode)}
          aria-label={label}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code} dir={language.direction}>
              {language.name} — {language.nativeName}
            </option>
          ))}
        </select>
      </span>
    </label>
  )
}
