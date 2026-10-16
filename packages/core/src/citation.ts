import { z } from "zod";

export const citationSchema = z.object({
  title: z.string(),
  url: z.string().min(1),
  snippet: z.string().default(""),
});

export type Citation = z.infer<typeof citationSchema>;

export type CitationInput = z.input<typeof citationSchema>;
