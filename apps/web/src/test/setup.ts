import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { stubMatchMedia } from "./match-media";

if (typeof window.matchMedia !== "function") {
  stubMatchMedia(false);
}

afterEach(() => {
  cleanup();
});
