import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config";
import { motionDurationMs, toCubicBezier } from "@/lib/motion";
import { contrastRatio, parseHslTriple, readThemeTokens, sourceRoot } from "./css-tokens";

const themedColorTokens = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "primary-subtle",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "highlight",
  "highlight-foreground",
  "highlight-subtle",
  "success",
  "success-foreground",
  "success-subtle",
  "warning",
  "warning-foreground",
  "warning-subtle",
  "danger",
  "danger-foreground",
  "danger-subtle",
  "info",
  "info-foreground",
  "info-subtle",
  "destructive",
  "destructive-foreground",
  "confidence-high",
  "confidence-high-subtle",
  "confidence-medium",
  "confidence-medium-subtle",
  "confidence-low",
  "confidence-low-subtle",
  "confidence-unassessed",
  "confidence-unassessed-subtle",
  "sidebar-background",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
];

const themedShadowTokens = ["elevation-1", "elevation-2", "elevation-3"];

const textContrastPairs: Array<[string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "card"],
  ["primary-foreground", "primary"],
  ["primary", "background"],
  ["primary", "card"],
  ["primary", "primary-subtle"],
  ["primary", "sidebar-accent"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["highlight-foreground", "highlight"],
  ["highlight", "background"],
  ["highlight", "highlight-subtle"],
  ["foreground", "highlight-subtle"],
  ["success-foreground", "success"],
  ["success", "success-subtle"],
  ["success", "background"],
  ["warning-foreground", "warning"],
  ["warning", "warning-subtle"],
  ["warning", "background"],
  ["danger-foreground", "danger"],
  ["danger", "danger-subtle"],
  ["danger", "background"],
  ["info-foreground", "info"],
  ["info", "info-subtle"],
  ["info", "background"],
  ["destructive-foreground", "destructive"],
  ["confidence-high", "confidence-high-subtle"],
  ["confidence-medium", "confidence-medium-subtle"],
  ["confidence-low", "confidence-low-subtle"],
  ["confidence-unassessed", "confidence-unassessed-subtle"],
  ["confidence-high", "background"],
  ["confidence-medium", "background"],
  ["confidence-low", "background"],
  ["confidence-unassessed", "background"],
  ["sidebar-foreground", "sidebar-background"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

const nonTextContrastPairs: Array<[string, string]> = [
  ["ring", "background"],
  ["input", "background"],
  ["input", "card"],
];

const externallyProvidedVariables = new Set(["font-geist-sans", "font-geist-mono"]);

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }

    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function referencedVariables(source: string): string[] {
  return [...source.matchAll(/var\(--([\w-]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => name && !name.startsWith("tw-") && !externallyProvidedVariables.has(name));
}

const { css, light, dark } = readThemeTokens();
const themes = { light, dark };

describe("design tokens", () => {
  it.each(Object.entries(themes))("defines every color token in the %s theme", (_, tokens) => {
    for (const name of themedColorTokens) {
      expect(tokens[name], `--${name}`).toBeDefined();
      expect(() => parseHslTriple(tokens[name] ?? ""), `--${name}`).not.toThrow();
    }

    for (const name of themedShadowTokens) {
      expect(tokens[name], `--${name}`).toBeDefined();
    }
  });

  it("defines the same color tokens in both themes", () => {
    const lightColors = Object.keys(light).filter((name) => themedColorTokens.includes(name));
    const darkColors = Object.keys(dark).filter((name) => themedColorTokens.includes(name));
    expect(darkColors.sort()).toEqual(lightColors.sort());
  });

  it("defines every variable referenced by the Tailwind theme and components", () => {
    const sources = [
      JSON.stringify(tailwindConfig.theme),
      ...collectSourceFiles(sourceRoot).map((file) => readFileSync(file, "utf8")),
    ];
    const missing = new Set<string>();
    for (const source of sources) {
      for (const name of referencedVariables(source)) {
        if (!(name in light)) {
          missing.add(name);
        }
      }
    }

    expect([...missing]).toEqual([]);
  });

  it.each(Object.entries(themes))("meets WCAG AA text contrast in the %s theme", (_, tokens) => {
    for (const [foreground, background] of textContrastPairs) {
      const ratio = contrastRatio(tokens[foreground] ?? "", tokens[background] ?? "");
      expect(ratio, `--${foreground} on --${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.entries(themes))(
    "meets WCAG AA non-text contrast for controls in the %s theme",
    (_, tokens) => {
      for (const [foreground, background] of nonTextContrastPairs) {
        const ratio = contrastRatio(tokens[foreground] ?? "", tokens[background] ?? "");
        expect(ratio, `--${foreground} on --${background}`).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("keeps CSS motion variables in sync with the motion token module", () => {
    expect(light["duration-fast"]).toBe(`${motionDurationMs.fast}ms`);
    expect(light["duration-base"]).toBe(`${motionDurationMs.base}ms`);
    expect(light["duration-slow"]).toBe(`${motionDurationMs.slow}ms`);
    expect(light["ease-standard"]).toBe(toCubicBezier("standard"));
    expect(light["ease-emphasized"]).toBe(toCubicBezier("emphasized"));
  });

  it("collapses CSS animation under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("uses the class strategy so next-themes can toggle the dark token set", () => {
    expect(tailwindConfig.darkMode).toBe("class");
  });
});
