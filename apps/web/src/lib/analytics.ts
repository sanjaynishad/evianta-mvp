import type { IntakeMode, UseCase } from "@evianta/core";

export type IntakeEventName =
  | "intake_started"
  | "intake_mode_switched"
  | "source_connected"
  | "source_items_attached"
  | "case_submitted";

// Only modes, kinds of work, connector ids, and counts are sent; never titles, prompts, or files.
export interface IntakeEventParams {
  mode?: IntakeMode;
  use_case?: UseCase;
  from_mode?: IntakeMode;
  connector?: string;
  count?: number;
}

function push(..._values: unknown[]) {
  // eslint-disable-next-line prefer-rest-params -- Google tag consumes Arguments objects.
  window.dataLayer?.push(arguments);
}

// A no-op until the Google tag has set up `dataLayer` on a public page.
export function trackEvent(name: IntakeEventName, params: IntakeEventParams = {}) {
  if (typeof window === "undefined" || !window.dataLayer) {
    return;
  }

  const defined = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  push("event", name, defined);
}
