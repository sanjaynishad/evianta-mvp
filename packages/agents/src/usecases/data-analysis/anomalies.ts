import { maxOf, robustZScores, roundTo, theilSenFit, type RobustScoreMethod } from "./stats.js";

export const ANOMALY_SCORE_THRESHOLD = 3.5;
export const MIN_PERIODS_FOR_ANOMALIES = 4;
const RESIDUAL_NOISE_FACTOR = 1e-9;

export interface PeriodAnomaly {
  id: string;
  period: string;
  /** Position of the period in the series. */
  index: number;
  value: number;
  /** Value of the robust trend line for this period. */
  expected: number;
  deviation: number;
  /** Deviation relative to the expected value in percent; undefined when expected is zero. */
  deviationPct?: number;
  /** Robust z-score of the deviation from the trend. */
  score: number;
  direction: "spike" | "drop";
  method: RobustScoreMethod;
  rows: number[];
}

export type AnomalyScreeningStatus = "scored" | "too-few-periods" | "no-variation";

export interface AnomalyScreening {
  status: AnomalyScreeningStatus;
  periods: number;
  minPeriods: number;
  anomalies: PeriodAnomaly[];
}

export interface AnomalyOptions {
  threshold?: number;
  minPeriods?: number;
}

/**
 * Flags periods whose total departs from the robust (Theil-Sen) trend by a robust z-score above the
 * threshold, so a steady growth trend is not itself reported as anomalous. The status says whether
 * the periods were scored at all: too few periods, or totals that sit exactly on the trend, are not.
 */
export function screenPeriodAnomalies(
  periods: ReadonlyArray<{ period: string; total: number; rows?: readonly number[] }>,
  options: AnomalyOptions = {},
): AnomalyScreening {
  const threshold = options.threshold ?? ANOMALY_SCORE_THRESHOLD;
  const minPeriods = options.minPeriods ?? MIN_PERIODS_FOR_ANOMALIES;

  if (periods.length < minPeriods) {
    return { status: "too-few-periods", periods: periods.length, minPeriods, anomalies: [] };
  }

  const values = periods.map((period) => period.total);
  const fit = theilSenFit(values);
  const expected = values.map((_value, index) => fit.intercept + fit.slope * index);
  const residuals = values.map((value, index) => value - (expected[index] as number));
  // Residuals below this are floating-point noise from the fit, not real deviations.
  const noise =
    maxOf(
      values.map((value) => Math.abs(value)),
      0,
    ) * RESIDUAL_NOISE_FACTOR;
  const robust = robustZScores(
    residuals.map((residual) => (Math.abs(residual) <= noise ? 0 : residual)),
  );

  if (!robust) {
    return { status: "no-variation", periods: periods.length, minPeriods, anomalies: [] };
  }

  const anomalies = periods.flatMap((period, index): PeriodAnomaly[] => {
    const score = robust.scores[index] as number;

    if (Math.abs(score) <= threshold) {
      return [];
    }

    const expectedValue = roundTo(expected[index] as number);
    const deviation = roundTo(period.total - expectedValue);

    return [
      {
        id: `anomaly-${period.period}`,
        period: period.period,
        index,
        value: period.total,
        expected: expectedValue,
        deviation,
        ...(expectedValue === 0
          ? {}
          : { deviationPct: roundTo((deviation / Math.abs(expectedValue)) * 100) }),
        score: roundTo(score),
        direction: score > 0 ? "spike" : "drop",
        method: robust.method,
        rows: [...(period.rows ?? [])],
      },
    ];
  });
  return { status: "scored", periods: periods.length, minPeriods, anomalies };
}

export function detectPeriodAnomalies(
  periods: ReadonlyArray<{ period: string; total: number; rows?: readonly number[] }>,
  options: AnomalyOptions = {},
): PeriodAnomaly[] {
  return screenPeriodAnomalies(periods, options).anomalies;
}
