/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./electron/**/*.html",
    "./public/*.html",
    "./src/**/*.jsx"
  ],
  theme: {
    extend: {
      colors: {
        'brand': {
          50: '#f3f4f6',
          100: '#e5e7eb',
          200: '#d1d5db',
          300: '#9ca3af',
          400: '#6b7280',
          500: '#4b5563',
          600: '#374151',
          700: '#1f2937',
          800: '#111827',
          900: '#0f141e',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}