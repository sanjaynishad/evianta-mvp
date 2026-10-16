import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";
import animate from "tailwindcss-animate";
import { motionDurationMs, toCubicBezier } from "./src/lib/motion";

function token(name: string): string {
  return `hsl(var(--${name}) / <alpha-value>)`;
}

function toneScale(name: string) {
  return {
    DEFAULT: token(name),
    foreground: token(`${name}-foreground`),
    subtle: token(`${name}-subtle`),
  };
}

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1440px" },
    },
    fontSize: {
      xs: ["0.75rem", { lineHeight: "1rem" }],
      sm: ["0.875rem", { lineHeight: "1.25rem" }],
      base: ["1rem", { lineHeight: "1.5rem" }],
      lg: ["1.125rem", { lineHeight: "1.75rem" }],
      xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em" }],
      "2xl": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.015em" }],
      "3xl": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em" }],
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", ...defaultTheme.fontFamily.sans],
        mono: ["var(--font-geist-mono)", ...defaultTheme.fontFamily.mono],
      },
      colors: {
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        primary: toneScale("primary"),
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
        destructive: {
          DEFAULT: token("destructive"),
          foreground: token("destructive-foreground"),
        },
        highlight: toneScale("highlight"),
        success: toneScale("success"),
        warning: toneScale("warning"),
        danger: toneScale("danger"),
        info: toneScale("info"),
        confidence: {
          high: { DEFAULT: token("confidence-high"), subtle: token("confidence-high-subtle") },
          medium: {
            DEFAULT: token("confidence-medium"),
            subtle: token("confidence-medium-subtle"),
          },
          low: { DEFAULT: token("confidence-low"), subtle: token("confidence-low-subtle") },
          unassessed: {
            DEFAULT: token("confidence-unassessed"),
            subtle: token("confidence-unassessed-subtle"),
          },
        },
        sidebar: {
          DEFAULT: token("sidebar-background"),
          foreground: token("sidebar-foreground"),
          border: token("sidebar-border"),
          accent: token("sidebar-accent"),
          "accent-foreground": token("sidebar-accent-foreground"),
        },
        chart: {
          1: token("chart-1"),
          2: token("chart-2"),
          3: token("chart-3"),
          4: token("chart-4"),
          5: token("chart-5"),
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        "elevation-1": "var(--elevation-1)",
        "elevation-2": "var(--elevation-2)",
        "elevation-3": "var(--elevation-3)",
      },
      transitionDuration: {
        fast: `${motionDurationMs.fast}ms`,
        base: `${motionDurationMs.base}ms`,
        slow: `${motionDurationMs.slow}ms`,
      },
      transitionTimingFunction: {
        standard: toCubicBezier("standard"),
        emphasized: toCubicBezier("emphasized"),
      },
      keyframes: {
        "evidence-pulse": {
          "0%": { boxShadow: "0 0 0 0 hsl(var(--highlight) / 0.45)" },
          "100%": { boxShadow: "0 0 0 8px hsl(var(--highlight) / 0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "evidence-pulse": `evidence-pulse ${motionDurationMs.slow * 2}ms ${toCubicBezier("standard")} 2`,
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
