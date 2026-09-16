// Minimal flat config with one job: catch identifiers that don't resolve.
//
// Two bugs this session were the same shape — a reference that survives the
// build because Vite treats an unknown identifier as a presumed runtime
// global, then throws in the browser:
//   - GroupDetail called handleAddEvent after it was deleted (caught by luck)
//   - EventDetail read VENUE_CATEGORIES / SOURCE_CONFIG, left behind in
//     Events.jsx by the extraction. Member access, so no call-site or JSX
//     scan would spot it. Black screen on every event, both screens.
//
// Deliberately narrow: `npm run lint` should be a bug detector, not a style
// argument, so it stays runnable and nobody learns to ignore its output.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

export default [
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'android/**', 'ios/**', 'backend/**', 'output/**', 'synthetic_data/**', 'neon_boteco_rebrand/**', 'New folder/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // Core no-unused-vars doesn't know a capitalized JSX tag (<Foo />) is
      // a reference to `Foo` — without this, every component used only in
      // JSX (i.e. nearly all of them) reads as unused. This was the ~288
      // false "unused" warnings docs/NEXT.md flagged as hiding real ones.
      // Only this one rule from eslint-plugin-react, not its recommended
      // set — this file's job is catching bugs, not style arguments.
      'react/jsx-uses-vars': 'warn',
      // Hook dependency mistakes are the other silent-at-build-time class.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      // Noise we don't want to argue about.
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-extra-boolean-cast': 'off',
      'preserve-caught-error': 'off',
    },
  },
]
