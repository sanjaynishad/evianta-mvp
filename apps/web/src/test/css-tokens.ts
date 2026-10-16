import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TokenSet = Record<string, string>;

export const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const globalsCssPath = join(sourceRoot, "app", "globals.css");

function extractBlock(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      return match[2] ?? "";
    }
  }

  throw new Error(`Selector ${selector} not found`);
}

export function parseTokenBlock(css: string, selector: string): TokenSet {
  const block = extractBlock(css, selector);
  const tokens: TokenSet = {};
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) {
      tokens[name] = value.trim();
    }
  }

  return tokens;
}

export function readThemeTokens(): { light: TokenSet; dark: TokenSet; css: string } {
  const css = readFileSync(globalsCssPath, "utf8");
  return { css, light: parseTokenBlock(css, ":root"), dark: parseTokenBlock(css, ".dark") };
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const huePrime = hue / 60;
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let rgb: [number, number, number] = [0, 0, 0];
  if (huePrime < 1) {
    rgb = [chroma, secondary, 0];
  } else if (huePrime < 2) {
    rgb = [secondary, chroma, 0];
  } else if (huePrime < 3) {
    rgb = [0, chroma, secondary];
  } else if (huePrime < 4) {
    rgb = [0, secondary, chroma];
  } else if (huePrime < 5) {
    rgb = [secondary, 0, chroma];
  } else {
    rgb = [chroma, 0, secondary];
  }

  const offset = l - chroma / 2;
  return [rgb[0] + offset, rgb[1] + offset, rgb[2] + offset];
}

export function parseHslTriple(value: string): [number, number, number] {
  const match = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
  if (!match) {
    throw new Error(`Not an HSL triple: ${value}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = hslToRgb(...parseHslTriple(value)).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
