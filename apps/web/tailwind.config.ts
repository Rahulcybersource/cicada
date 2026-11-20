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
        // Warm Pastel Editorial Palette
        frame: "#C7BBB8",           // Dusty taupe outer frame
        sidebar: "#F8F6F3",         // Alabaster left nav
        workspace: "#FFFFFF",       // Pure white primary
        feed: "#F9F7F4",            // Warm off-white pinned column
        rail: "#F8F6F3",            // Alabaster right utility rail
        hairline: "#ECE7E2",        // 1px borders
        ink: "#1A1918",             // Near-black primary text
        muted: "#7A746E",           // Muted warm grey secondary text
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
        // State colors
        excellent: "#6B9E6B",
        good: "#8FBC8F",
        fair: "#E8B86D",
        poor: "#D47A7A",
        // AI Provider badges
        "groq-live": "#F5D5C0",
        "gemini-live": "#D8E2E6",
        "deterministic-fallback": "#EFC5BC",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-plus-jakarta)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "card": "0 2px 8px -2px rgba(26, 25, 24, 0.08), 0 1px 3px -1px rgba(26, 25, 24, 0.05)",
        "card-hover": "0 4px 16px -4px rgba(26, 25, 24, 0.12), 0 2px 6px -2px rgba(26, 25, 24, 0.08)",
      },
      borderRadius: {
        "card": "12px",
        "pill": "9999px",
      },
    },
  },
  plugins: [],
};

export default config;