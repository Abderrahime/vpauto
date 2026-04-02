/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  prefix: 'vpa-',  // Prefix to avoid conflicts with VPauto's own CSS
  theme: {
    extend: {
      colors: {
        vpauto: {
          blue: '#003366',
          orange: '#f47920',
          light: '#f5f5f5',
          success: '#22c55e',
          danger: '#ef4444',
          warning: '#f59e0b',
        },
      },
    },
  },
  plugins: [],
};
