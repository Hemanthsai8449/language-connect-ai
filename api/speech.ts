import speech from '../netlify/functions/speech.js'

export default {
  fetch(request: Request) {
    return speech(request)
  },
}
