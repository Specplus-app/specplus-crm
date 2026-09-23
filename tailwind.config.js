/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        obsidian: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5dae2',
          300: '#b0b9c8',
          400: '#8592a8',
          500: '#66748d',
          600: '#515d74',
          700: '#434c5e',
          800: '#3a4150',
          900: '#232833',
          950: '#0d0f14',
        },
        cobalt: {
          50: '#eef4ff',
          100: '#d9e6ff',
          200: '#bcd3ff',
          300: '#8eb6ff',
          400: '#598dff',
          500: '#3563f6',
          600: '#2043e3',
          700: '#1a33c4',
          800: '#1c2f9f',
          900: '#1d2d7d',
          950: '#151d4c',
        },
      },
      backgroundImage: {
        'radial-spotlight': 'radial-gradient(circle at 50% 0%, rgba(53, 99, 246, 0.18), transparent 60%)',
        'metallic-gradient': 'linear-gradient(160deg, #598dff 0%, #2043e3 45%, #1a33c4 100%)',
      },
      boxShadow: {
        'glass-card': '0 24px 70px -24px rgba(0, 0, 0, 0.75), inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
        'glow-blue': '0 10px 30px -8px rgba(32, 67, 227, 0.55), 0 0 20px -6px rgba(53, 99, 246, 0.45)',
      },
    },
  },
  plugins: [],
}
