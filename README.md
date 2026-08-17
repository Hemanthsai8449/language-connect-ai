# Language Connect AI

Language Connect AI is a responsive, accessible translator for English and the 22 languages in the Eighth Schedule of the Constitution of India. It combines a React interface, a protected serverless backend, Sarvam AI translation and speech recognition, and optional read-aloud output.

Live application: [languageconnectai.vercel.app](https://languageconnectai.vercel.app)

## Supported languages

English, Assamese, Bengali, Bodo, Dogri, Gujarati, Hindi, Kannada, Kashmiri, Konkani, Maithili, Malayalam, Manipuri, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali, Sindhi, Tamil, Telugu, and Urdu.

No other language code is accepted by either the interface or the backend.

## Technology

- React 19 + TypeScript + Vite
- Vercel Functions and Netlify Functions adapters for the protected backend
- Sarvam AI `sarvam-translate:v1` for all 23 supported languages
- Browser microphone recording normalized to 16 kHz mono WAV with protected Sarvam AI speech-to-text
- Sarvam AI cloud voices with an exact browser/device voice fallback
- Vitest + Testing Library
- Hand-authored responsive CSS with a polished Apple Glass light/dark theme and reduced-motion/transparency support

## Environment variables

Copy `.env.example` to `.env` for local development.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SARVAM_API_KEY` | Yes | — | Secret key used only by the Netlify Function to call Sarvam AI. |
| `MAX_INPUT_CHARACTERS` | No | `2000` | Input limit. Values above 2,000 are capped because that is the provider limit. |
| `TRANSLATION_TIMEOUT_MS` | No | `25000` | Provider timeout, capped at 45 seconds. |
| `SPEECH_TIMEOUT_MS` | No | `45000` | Text-to-speech timeout, capped at 60 seconds. |
| `TRANSCRIPTION_TIMEOUT_MS` | No | `40000` | Speech-to-text timeout, capped at 50 seconds. |

Never prefix the secret with `VITE_`. Vite-prefixed variables are bundled into public browser code.

## Local development

Requirements: Node.js 24 (recommended; Node 20.19+ is also compatible) and npm.

```powershell
Copy-Item .env.example .env
# Put your real SARVAM_API_KEY in .env
npm install
npm run build
npm run local
```

`npm run local` serves the production frontend and all three protected API routes at `http://localhost:8888`. `npm run dev` starts only the Vite interface, so the `/api` routes require the local server, Netlify Dev, or a deployed site.

Voice input records a short audio clip, checks that the microphone captured an audible signal, and converts it to a standard 16 kHz mono PCM WAV before sending it through the protected Netlify backend to Sarvam AI. Recordings stop automatically after 20 seconds. If **Speak** does not start or the app reports quiet audio, use a current Chrome, Edge, or Safari browser, open the app on HTTPS or `localhost`, allow Microphone for that exact site, and confirm the correct input device is selected and unmuted in the browser and operating-system privacy settings.

Useful checks:

```powershell
npm test
npm run typecheck:functions
npm run build
```

## Deploy to Netlify

1. Push this folder to a Git provider and import the repository into Netlify, or run `npx netlify init`.
2. If this project is inside a larger repository, set the Netlify base directory to `language connect ai`.
3. Netlify reads the build command, publish directory, Functions directory, SPA fallback, security headers, and API rate limit from `netlify.toml`.
4. In **Site configuration → Environment variables**, add `SARVAM_API_KEY` for the Production context (and Deploy Previews if desired).
5. Deploy. The production build command is `npm run build`, and the published directory is `dist`.

Runtime secrets for Functions must be configured in the Netlify UI, CLI, or API; do not put the real key in `netlify.toml` or commit a `.env` file.

## Deploy to Vercel

1. Push this folder to a GitHub repository and import it into Vercel, or link it with the Vercel CLI.
2. Vercel reads the Vite build, `dist` output, API Function limits, SPA fallback, and security headers from `vercel.json`.
3. In **Project Settings → Environment Variables**, add `SARVAM_API_KEY` to Production and Preview. Mark it as sensitive.
4. Deploy and verify `/api/translate`, `/api/speech`, and `/api/transcribe` from the HTTPS site.
5. Because these routes spend Sarvam credits, create a Vercel Firewall rate-limit rule for `/api/*` before sharing the site publicly.

The real `.env` file and Vercel's local `.vercel` project metadata are excluded from Git.

## Architecture and safety

The browser sends `{ text, sourceLanguage, targetLanguage }` to `/api/translate`. The serverless Function validates the exact 23-language allowlist and length, retrieves `SARVAM_API_KEY` on the server, calls Sarvam AI, and returns only the translated text and a request ID. For voice input, the browser sends a maximum 20-second recording to `/api/transcribe`; the Function enforces a 2 MiB limit and forwards it to Sarvam `saaras:v3` without exposing the key. For supported read-aloud voices, `/api/speech` streams audio from Sarvam.

The production Vercel site uses a Firewall rule that limits `/api/*` to 20 combined requests per IP per minute. The optional Netlify configuration separately limits translation to 30 requests, speech generation to 12, and transcription to 8. Request bodies are validated, provider errors are normalized, responses are not cached, and submitted text or audio is not stored by this app. Sarvam AI still processes submitted content, so review its terms before handling sensitive material.

## Product notes

- The selected Sarvam model produces formal translations and requires an explicit source language.
- Input is limited to 2,000 Unicode characters per request.
- Sarvam `saaras:v3` speech-to-text supports all 23 app languages. The short REST flow is capped at 20 seconds in the interface.
- Sarvam Bulbul v3 read-aloud supports English, Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, and Odia. The other languages use an exact browser/device voice only when installed; the interface reports when no matching voice exists.
- AI translations may miss context or regional nuance. Important medical, legal, or financial content should be verified by a qualified speaker.
