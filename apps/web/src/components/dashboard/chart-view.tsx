"use client";

import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartSpec, ChartValueFormat } from "@evianta/core";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import {
  formatIndianCompact,
  formatInr,
  formatInrCompact,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const seriesColors = [1, 2, 3, 4, 5].map((index) => `hsl(var(--chart-${index}))`);

function colorAt(index: number): string {
  return seriesColors[index % seriesColors.length] ?? "currentColor";
}

export function formatChartValue(
  value: unknown,
  format: ChartValueFormat,
  compact = false,
): string {
  if (typeof value !== "number") {
    return value === null || value === undefined ? "" : String(value);
  }

  if (format === "percent") {
    return formatPercent(value);
  }

  if (format === "currency-inr") {
    return compact ? formatInrCompact(value, 1) : formatInr(value);
  }

  return compact ? formatIndianCompact(value, 1) : formatNumber(value);
}

export interface ChartViewProps {
  spec: ChartSpec;
  footer?: ReactNode;
  // Fixed dimensions skip ResponsiveContainer, for tests and print.
  size?: { width: number; height: number };
  className?: string;
}

function ChartBody({ spec, size }: Pick<ChartViewProps, "spec" | "size">) {
  const { reduced } = useMotionSafe();
  const valueFormat = spec.yAxis?.format ?? "number";
  const animate = !reduced;
  const tooltipFormatter = (value: unknown) => formatChartValue(value, valueFormat);
  const tickFormatter = (value: unknown) => formatChartValue(value, valueFormat, true);
  const tooltipStyle = {
    backgroundColor: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "var(--radius)",
    color: "hsl(var(--popover-foreground))",
    fontSize: 12,
  };
  const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 12 };
  const width = size?.width;
  const height = size?.height;

  if (spec.type === "pie") {
    const series = spec.series[0];
    const data = spec.data.map((datum, index) => ({ ...datum, fill: colorAt(index) }));
    return (
      <PieChart width={width} height={height}>
        <Pie
          data={data}
          dataKey={series?.key ?? ""}
          nameKey={spec.categoryKey}
          innerRadius="45%"
          outerRadius="80%"
          paddingAngle={1}
          stroke="hsl(var(--card))"
          isAnimationActive={animate}
        />
        <Tooltip formatter={tooltipFormatter} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    );
  }

  const axes = (
    <>
      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey={spec.categoryKey}
        tick={axisTick}
        tickLine={false}
        axisLine={{ stroke: "hsl(var(--border))" }}
      />
      <YAxis
        tick={axisTick}
        tickLine={false}
        axisLine={false}
        tickFormatter={tickFormatter}
        width={72}
      />
      <Tooltip formatter={tooltipFormatter} contentStyle={tooltipStyle} />
      {spec.series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
    </>
  );

  if (spec.type === "line") {
    return (
      <LineChart data={spec.data} width={width} height={height}>
        {axes}
        {spec.series.map((series, index) => (
          <Line
            key={series.key}
            type="monotone"
            dataKey={series.key}
            name={series.label}
            stroke={colorAt(index)}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={animate}
          />
        ))}
      </LineChart>
    );
  }

  return (
    <BarChart data={spec.data} width={width} height={height}>
      {axes}
      {spec.series.map((series, index) => (
        <Bar
          key={series.key}
          dataKey={series.key}
          name={series.label}
          fill={colorAt(index)}
          radius={[3, 3, 0, 0]}
          isAnimationActive={animate}
        />
      ))}
    </BarChart>
  );
}

export function ChartView({ spec, footer, size, className }: ChartViewProps) {
  const valueFormat = spec.yAxis?.format ?? "number";
  const captionId = `${spec.id}-caption`;
  return (
    <figure
      data-chart-id={spec.id}
      data-chart-type={spec.type}
      aria-labelledby={captionId}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-elevation-1",
        className,
      )}
    >
      <figcaption id={captionId} className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{spec.title}</span>
        {spec.description ? (
          <span className="text-xs text-muted-foreground">{spec.description}</span>
        ) : null}
      </figcaption>
      <div aria-hidden className="h-64 w-full">
        {size ? (
          <ChartBody spec={spec} size={size} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ChartBody spec={spec} />
          </ResponsiveContainer>
        )}
      </div>
      <table className="sr-only">
        <caption>{spec.title}</caption>
        <thead>
          <tr>
            <th scope="col">{spec.xAxis?.label ?? spec.categoryKey}</th>
            {spec.series.map((series) => (
              <th key={series.key} scope="col">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.data.map((datum, index) => (
            <tr key={`${String(datum[spec.categoryKey])}-${index}`}>
              <th scope="row">{String(datum[spec.categoryKey] ?? "")}</th>
              {spec.series.map((series) => (
                <td key={series.key}>{formatChartValue(datum[series.key], valueFormat)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {spec.source ? (
        <p className="text-xs text-muted-foreground">Source: {spec.source.aggregation}</p>
      ) : null}
      {footer}
    </figure>
  );
}
