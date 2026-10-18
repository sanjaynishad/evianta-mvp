import { formatEmailDate } from "./format.js";

export interface EmailMessage {
  from: string;
  to: string;
  cc?: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  /** India Standard Time (hh:mm). */
  time: string;
  subject: string;
  body: readonly string[];
}

const MESSAGE_SEPARATOR = "----------------------------------------";

export const SYNTHETIC_EMAIL_NOTE =
  "[Synthetic demo data from an Evianta demo connector. Not a real email.]";

function renderMessage(message: EmailMessage): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    `Date: ${formatEmailDate(message.date, message.time)}`,
    `Subject: ${message.subject}`,
  ];

  return [...headers, "", ...message.body].join("\n");
}

/** A mailbox export: each message has header lines, a blank line, then its body. */
export function composeEmailThread(messages: readonly EmailMessage[]): string {
  return `${[...messages.map(renderMessage), SYNTHETIC_EMAIL_NOTE].join(`\n\n${MESSAGE_SEPARATOR}\n\n`)}\n`;
}
