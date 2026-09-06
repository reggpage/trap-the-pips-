import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        role: {
          worker: 'rgb(var(--role-worker) / <alpha-value>)',
          accountant: 'rgb(var(--role-accountant) / <alpha-value>)',
          admin: 'rgb(var(--role-admin) / <alpha-value>)',
        },
        sidebar: 'rgb(var(--sidebar-bg) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
          border: 'rgb(var(--surface-border) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
        },
        // Exercise-book tokens for the marketing and auth pages. Named "book",
        // not "cover": bg-cover is already a Tailwind background-size utility.
        book: {
          DEFAULT: 'rgb(var(--cover) / <alpha-value>)',
          soft: 'rgb(var(--cover-soft) / <alpha-value>)',
        },
        paper: {
          DEFAULT: 'rgb(var(--paper) / <alpha-value>)',
          rule: 'rgb(var(--paper-rule) / <alpha-value>)',
        },
      },
      fontFamily: {
        // Outfit is the primary UI face: geometric sans with wide language coverage.
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Lora reserved for large numeric displays where a slight serif feel adds gravitas
        // (dashboard metrics, invoice totals). Apply via `font-display` utility.
        display: ['Lora', 'ui-serif', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
