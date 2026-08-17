import translate from '../netlify/functions/translate.js'

export default {
  fetch(request: Request) {
    return translate(request)
  },
}
