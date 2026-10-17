import { render, screen, within } from "@testing-library/react";
import { chartSpecSchema, type DeliverableSection } from "@evianta/core";
import { beforeAll, describe, expect, it } from "vitest";
import { dataAnalysisChartSpecs } from "@/fixtures/data-analysis";
import { stubResizeObserver } from "@/test/render-with-data";
import { ChartSection } from "./chart-section";
import { ChartView, formatChartValue } from "./chart-view";

const size = { width: 480, height: 240 };

beforeAll(() => {
  stubResizeObserver();
});

describe("ChartView", () => {
  it.each(dataAnalysisChartSpecs.map((raw) => [raw.type, chartSpecSchema.parse(raw)] as const))(
    "renders a %s chart from its spec with an accessible data table",
    (type, spec) => {
      const { container } = render(<ChartView spec={spec} size={size} />);

      const figure = screen.getByRole("figure", { name: new RegExp(spec.title) });
      expect(figure).toHaveAttribute("data-chart-type", type);
      expect(container.querySelector("svg")).not.toBeNull();
      expect(container.querySelector(`.recharts-${type}`)).not.toBeNull();
      const table = within(figure).getByRole("table");
      expect(within(table).getAllByRole("row")).toHaveLength(spec.data.length + 1);
      const chart = within(figure).getByRole("group", { name: `${spec.title} chart` });
      expect(chart).toHaveAttribute("aria-describedby", table.id);
      expect(container.querySelector("svg")?.closest("[aria-hidden='true']")).toBeNull();
      expect(within(figure).getByText(`Source: ${spec.source?.aggregation}`)).toBeInTheDocument();
    },
  );

  it("formats values by the axis format", () => {
    expect(formatChartValue(0.092, "percent")).toBe("9.2%");
    expect(formatChartValue(4625000, "currency-inr", true)).toBe("₹46.3 lakh");
    expect(formatChartValue(null, "number")).toBe("");
  });
});

describe("ChartSection", () => {
  it("explains a chart section that cannot be drawn", () => {
    const section: DeliverableSection = {
      id: "s1",
      title: "Broken chart",
      kind: "chart",
      content: "{}",
      producedByRole: "business-data-analyst",
      findingIds: [],
      evidenceIds: [],
      reviewStatus: "pending",
    };

    render(<ChartSection section={section} size={size} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Broken chart could not be drawn");
  });
});
