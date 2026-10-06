// ESLint flat config.
//
// The reason this file exists at all: v1.0.86 shipped a completely broken
// player while `vite build` stayed green. `togglePlayPause` was referenced but
// never declared. A bundler cannot catch an undefined global identifier - it
// happily emits a call to a name it assumes exists - so the build passed and
// the component threw ReferenceError at render, meaning the <video> element
// never mounted and nothing ever played.
//
// `no-undef` as a hard error is what makes that unshippable again.
//
// Rule policy, deliberately split:
//   * Real bug classes stay ERRORS everywhere we own the code:
//     no-undef, no-dupe-*, no-unreachable, no-redeclare, no-fallthrough,
//     no-self-compare, no-unsafe-negation, no-const-assign.
//   * Style/cleanup rules are ERRORS in src/** (the renderer we ship, which is
//     clean) and WARNINGS in the older Electron/backend/config files, which
//     have hundreds of long-standing cosmetic violations. Reflowing 7000 lines
//     of `catch (_e) {}` is pure churn and pure regression risk right before a
//     release.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Rules that indicate an actual defect rather than a style preference. */
const correctnessRules = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-duplicate-imports': 'error',
  'no-import-assign': 'error',
  'no-setter-return': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-fallthrough': 'error',
  'no-func-assign': 'error',
  'valid-typeof': 'error',
};

/**
 * Cleanup rules. Strict in the renderer, advisory in legacy Node files.
 * `catch (_e) {}` is the house style for deliberately swallowed errors, so
 * unused catch bindings and empty catch blocks must not be errors.
 */
const strictCleanupRules = {
  'no-unused-vars': [
    'warn',
    {
      args: 'none',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-escape': 'error',
  'no-constant-binary-expression': 'error',
  'no-prototype-builtins': 'warn',
  'no-control-regex': 'warn',
};

const lenientCleanupRules = {
  'no-unused-vars': [
    'warn',
    {
      args: 'none',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-escape': 'warn',
  'no-constant-binary-expression': 'warn',
  'no-prototype-builtins': 'warn',
  'no-control-regex': 'warn',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'dist/**',
      'android/**',
      // Vite output, current location plus any stale relocated ones.
      'tests/.harness-dist/**',
      'tests/harness/.harness-dist/**',
      '**/*.min.js',
      // Vendored/prebuilt third-party bundles.
      'public/vendor/**',
    ],
  },

  js.configs.recommended,

  // ---------------------------------------------------------------- renderer
  // src/** is the code we are shipping for this release, so cleanup rules stay
  // hard errors here.
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...correctnessRules,
      ...strictCleanupRules,
      'react/jsx-uses-react': 'warn',
      'react/jsx-uses-vars': 'warn',
      'react/jsx-key': 'warn',
      'react/no-direct-mutation-state': 'error',
      // The component is large and deliberately leans on exhaustive-deps
      // suppression for stable stream identity; keep this advisory so a
      // pre-release refactor cannot silently restart streams.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // -------------------------------------------------------- browser harness
  // Standalone browser scripts that are NOT bundled by the main app build.
  // (tests/harness/vite.harness.config.js is excluded here - it is a build-time
  // ESM config, handled in the Node ESM block below.)
  {
    files: ['tests/harness/**/*.js', 'tests/fixtures/**/*.js'],
    ignores: ['tests/harness/vite.harness.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...correctnessRules, ...lenientCleanupRules },
  },

  // ----------------------------------------------------- ESM tooling (Node)
  {
    files: [
      'scripts/**/*.mjs',
      'backend/**/*.mjs',
      'tests/**/*.mjs',
      'tests/harness/vite.harness.config.js',
      'vitest.config.mjs',
      'eslint.config.mjs',
      'vite.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...correctnessRules, ...lenientCleanupRules },
  },

  // ------------------------------------------------- CommonJS Node services
  // package.json declares "type": "commonjs", so these must parse as scripts.
  {
    files: [
      'electron/**/*.js',
      'backends/**/*.js',
      'backend/**/*.js',
      'db/**/*.js',
      'config/**/*.js',
      'public/**/*.js',
      'scripts/**/*.js',
      'tailwind.config.js',
      'postcss.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...correctnessRules, ...lenientCleanupRules },
  },

  // ----------------------------------------------------- Vitest unit suites
  {
    files: ['tests/unit/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...correctnessRules, ...strictCleanupRules },
  },
];