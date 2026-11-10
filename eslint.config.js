// Minimal, dependency-free ESLint flat config: the goal is catching real
// runtime bugs (undefined names, TDZ use-before-define, redeclarations), not
// enforcing a house style. Tests/scripts are intentionally excluded: they use
// CommonJS top-level awaits and process exits.
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', localStorage: 'readonly',
  sessionStorage: 'readonly', fetch: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly',
  FileReader: 'readonly', FormData: 'readonly', Headers: 'readonly',
  Request: 'readonly', Response: 'readonly', AbortController: 'readonly',
  AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  Audio: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
  OfflineAudioContext: 'readonly', MediaRecorder: 'readonly',
  MediaStream: 'readonly', performance: 'readonly', console: 'readonly',
  crypto: 'readonly', btoa: 'readonly', atob: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', queueMicrotask: 'readonly',
  structuredClone: 'readonly', Intl: 'readonly', Image: 'readonly',
  DOMParser: 'readonly', XMLHttpRequest: 'readonly', matchMedia: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  visualViewport: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
  scrollTo: 'readonly', devicePixelRatio: 'readonly', Notification: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', KeyboardEvent: 'readonly',
  HTMLElement: 'readonly', Node: 'readonly', globalThis: 'readonly',
  self: 'readonly', process: 'readonly', module: 'readonly',
};
const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable',
  __dirname: 'readonly', __filename: 'readonly', process: 'readonly',
  Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', fetch: 'readonly', FormData: 'readonly',
  Blob: 'readonly', AbortSignal: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
  performance: 'readonly', globalThis: 'readonly',
};

const rules = {
  'no-undef': 'error',
  'no-use-before-define': ['error', { variables: true, functions: false, classes: true }],
  'no-redeclare': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-shadow': 'warn',
};

module.exports = [
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    rules,
  },
  {
    // app.js consumes the globals that parser.js / rythu-parser.js / resolver.js
    // / api.js define as classic <script>s earlier in index.html
    files: ['public/app.js'],
    languageOptions: {
      globals: {
        api: 'readonly', apiAudio: 'readonly', parse: 'readonly',
        diagnose: 'readonly', resolve: 'readonly', parseRythu: 'readonly',
      },
    },
  },
  {
    files: ['server.js', 'lib/**/*.js', 'security.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules,
  },
];
