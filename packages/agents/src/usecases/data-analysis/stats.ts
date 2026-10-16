export function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  const rounded = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * factor);

  return rounded / factor + 0;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface LinearFit {
  slope: number;
  intercept: number;
}

/** Theil-Sen estimator over x = 0..n-1: the median pairwise slope, robust to a few outliers. */
export function theilSenFit(values: readonly number[]): LinearFit {
  if (values.length < 2) {
    return { slope: 0, intercept: values[0] ?? 0 };
  }

  const slopes: number[] = [];

  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      slopes.push(((values[right] as number) - (values[left] as number)) / (right - left));
    }
  }

  const slope = median(slopes);
  const intercept = median(values.map((value, index) => value - slope * index));

  return { slope, intercept };
}

/** Converts a mean absolute deviation to a standard-deviation scale for normal data. */
export const MEAN_ABSOLUTE_DEVIATION_SCALE = 1.253314;

/** Converts a median absolute deviation to a standard-deviation scale (Iglewicz and Hoaglin). */
export const MEDIAN_ABSOLUTE_DEVIATION_SCALE = 0.6745;

export type RobustScoreMethod = "median-absolute-deviation" | "mean-absolute-deviation";

export interface RobustScores {
  scores: number[];
  method: RobustScoreMethod;
}

/**
 * Modified z-scores. Falls back to the mean absolute deviation when more than half of the values
 * are identical (median absolute deviation of zero); returns undefined when all values are equal.
 */
export function robustZScores(values: readonly number[]): RobustScores | undefined {
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const medianDeviation = median(deviations);

  if (medianDeviation > 0) {
    return {
      scores: values.map(
        (value) => (MEDIAN_ABSOLUTE_DEVIATION_SCALE * (value - center)) / medianDeviation,
      ),
      method: "median-absolute-deviation",
    };
  }

  const meanDeviation = sum(deviations) / deviations.length;

  if (!(meanDeviation > 0)) {
    return undefined;
  }

  return {
    scores: values.map(
      (value) => (value - center) / (MEAN_ABSOLUTE_DEVIATION_SCALE * meanDeviation),
    ),
    method: "mean-absolute-deviation",
  };
}

export function percentChange(from: number, to: number): number | undefined {
  if (from === 0) {
    return undefined;
  }

  return ((to - from) / Math.abs(from)) * 100;
}
