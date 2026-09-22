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
          600: '#2a3447',
          700: '#1c2434',
          800: '#161b26',
          900: '#0b0f17',
        },
        'accent': {
          400: '#34d399',
          500: '#10b981',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}