/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Terminal palette driven by CSS vars (themeable: dark default / html.light).
        // rgb(var() / <alpha-value>) keeps Tailwind opacity modifiers (e.g. /95) working.
        terminal: {
          bg: "rgb(var(--terminal-bg) / <alpha-value>)",
          panel: "rgb(var(--terminal-panel) / <alpha-value>)",
          elevated: "rgb(var(--terminal-elevated) / <alpha-value>)",
          border: "rgb(var(--terminal-border) / <alpha-value>)",
          "border-strong": "rgb(var(--terminal-border-strong) / <alpha-value>)",
          text: "rgb(var(--terminal-text) / <alpha-value>)",
          muted: "rgb(var(--terminal-muted) / <alpha-value>)",
        },
        accent: "rgb(var(--accent) / <alpha-value>)",
        flow: {
          buy: "#0e8a4f",
          buyHi: "#16c172",
          sell: "#b0263c",
          sellHi: "#ef4d63",
          neutral: "#3a4350",
          delta: "#2f81f7",
          absorption: "#8b5cf6",
          exhaustion: "#eab308",
          lpSupport: "#22c55e",
          lpResist: "#ef4444",
          ad: "#14b8a6",
        },
      },
      fontFamily: {
        sans: ["Outfit", "Inter", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "Menlo", "Monaco", "monospace"],
      },
    },
  },
  plugins: [],
};
