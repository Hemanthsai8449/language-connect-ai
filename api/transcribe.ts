import transcribe from '../netlify/functions/transcribe.js'

export default {
  fetch(request: Request) {
    return transcribe(request)
  },
}
