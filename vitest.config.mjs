import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom is enough for the pure-logic + static-analysis suites. Media
    // behaviour is verified for real in tests/e2e/playback.e2e.mjs against a
    // headless Chromium, because jsdom has no media pipeline.
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js', 'tests/unit/**/*.test.jsx'],
    globals: false,
    reporters: ['verbose'],
  },
});