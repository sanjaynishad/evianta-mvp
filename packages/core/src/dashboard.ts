import { z } from "zod";

export const chartTypeSchema = z.enum(["bar", "line", "area", "pie"]);

export type ChartType = z.infer<typeof chartTypeSchema>;

export const chartValueFormatSchema = z.enum(["number", "currency-inr", "percent"]);

export type ChartValueFormat = z.infer<typeof chartValueFormatSchema>;

export const chartSeriesSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});

export type ChartSeries = z.infer<typeof chartSeriesSchema>;

export const chartDatumSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export type ChartDatum = z.infer<typeof chartDatumSchema>;

export const chartAxisSchema = z.object({
  label: z.string().optional(),
  format: chartValueFormatSchema.default("number"),
});

export type ChartAxis = z.infer<typeof chartAxisSchema>;

export const chartSourceSchema = z.object({
  // Plain description of the aggregation behind the chart, for example "Sum of net sales by month".
  aggregation: z.string().min(1),
  documentId: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});

export type ChartSource = z.infer<typeof chartSourceSchema>;

export const chartSpecSchema = z
  .object({
    id: z.string().min(1),
    type: chartTypeSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    categoryKey: z.string().min(1),
    series: z.array(chartSeriesSchema).min(1),
    data: z.array(chartDatumSchema),
    xAxis: chartAxisSchema.optional(),
    yAxis: chartAxisSchema.optional(),
    source: chartSourceSchema.optional(),
  })
  .superRefine((spec, context) => {
    if (spec.type === "pie" && spec.series.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "A pie chart has exactly one series",
      });
    }
  });

export type ChartSpec = z.infer<typeof chartSpecSchema>;

export type ChartSpecInput = z.input<typeof chartSpecSchema>;

export const dashboardSpecSchema = z.object({
  title: z.string().optional(),
  charts: z.array(chartSpecSchema).min(1),
});

export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;

export type DashboardSpecInput = z.input<typeof dashboardSpecSchema>;

export type ChartSpecParseResult =
  { success: true; spec: ChartSpec } | { success: false; error: string };

// A dashboard deliverable stores one chart spec as JSON in the content of each "chart" section.
export function parseChartSpecContent(content: string): ChartSpecParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { success: false, error: "Chart content is not valid JSON" };
  }

  const parsed = chartSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  return { success: true, spec: parsed.data };
}
