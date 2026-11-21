import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // SOLARIUS OPS Core Warm Pastel Editorial Palette
        taupe: "#C7BBB8",           // Dusty taupe frame & accents
        alabaster: "#F8F6F3",       // Alabaster sidebars & utility rails
        canvas: "#F9F7F4",          // Warm off-white canvas / feed
        white: "#FFFFFF",           // Pure white workspace surfaces
        ink: "#18181B",             // Primary deep text
        stone: "#78716C",           // Secondary warm stone text
        muted: "#A8A29E",           // Muted warm grey tertiary text
        hairline: "#ECE7E2",        // 1px architectural borders
        blush: "#F3E2DB",           // Soft blush pastel accent
        peach: "#F5D9C8",           // Soft peach pastel accent

        // Semantic Aliases for Compatibility
        frame: "#C7BBB8",
        sidebar: "#F8F6F3",
        workspace: "#FFFFFF",
        feed: "#F9F7F4",
        rail: "#F8F6F3",

        // Signature Gradients
        "sage-mist-start": "#E6ECE4",
        "sage-mist-mid": "#D8E2E6",
        "sage-mist-end": "#C9D8DF",
        "blush-sand-start": "#F6E4DA",
        "blush-sand-mid": "#F3D5CC",
        "blush-sand-end": "#EFC5BC",
        "cream-apricot-start": "#F8EBDC",
        "cream-apricot-mid": "#F5D5C0",
        "cream-apricot-end": "#EFC2AE",

        // Health States
        excellent: "#6B9E6B",
        good: "#8FBC8F",
        fair: "#E8B86D",
        poor: "#D47A7A",

        // AI Provider Badges
        "groq-live": "#F5D5C0",
        "gemini-live": "#D8E2E6",
        "deterministic-fallback": "#EFC5BC",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "-apple-system", "sans-serif"],
        display: ["var(--font-plus-jakarta)", "Plus Jakarta Sans", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 2px 8px -2px rgba(24, 24, 27, 0.06), 0 1px 3px -1px rgba(24, 24, 27, 0.04)",
        "card-hover": "0 4px 16px -4px rgba(24, 24, 27, 0.10), 0 2px 6px -2px rgba(24, 24, 27, 0.06)",
        elevated: "0 8px 24px -4px rgba(24, 24, 27, 0.10), 0 4px 8px -2px rgba(24, 24, 27, 0.06)",
      },
      borderRadius: {
        card: "12px",
        pill: "9999px",
      },
    },
  },
  plugins: [],
};

export default config;
