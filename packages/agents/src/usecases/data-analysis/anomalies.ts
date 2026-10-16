import { robustZScores, roundTo, theilSenFit, type RobustScoreMethod } from "./stats.js";

export const ANOMALY_SCORE_THRESHOLD = 3.5;
export const MIN_PERIODS_FOR_ANOMALIES = 4;

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

export interface AnomalyOptions {
  threshold?: number;
  minPeriods?: number;
}

/**
 * Flags periods whose total departs from the robust (Theil-Sen) trend by a robust z-score above the
 * threshold, so a steady growth trend is not itself reported as anomalous.
 */
export function detectPeriodAnomalies(
  periods: ReadonlyArray<{ period: string; total: number; rows?: readonly number[] }>,
  options: AnomalyOptions = {},
): PeriodAnomaly[] {
  const threshold = options.threshold ?? ANOMALY_SCORE_THRESHOLD;
  const minPeriods = options.minPeriods ?? MIN_PERIODS_FOR_ANOMALIES;

  if (periods.length < minPeriods) {
    return [];
  }

  const values = periods.map((period) => period.total);
  const fit = theilSenFit(values);
  const expected = values.map((_value, index) => fit.intercept + fit.slope * index);
  const residuals = values.map((value, index) => value - (expected[index] as number));
  const robust = robustZScores(residuals);

  if (!robust) {
    return [];
  }

  return periods.flatMap((period, index): PeriodAnomaly[] => {
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
}
