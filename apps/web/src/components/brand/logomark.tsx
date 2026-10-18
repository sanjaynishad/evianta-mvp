import { useId, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export interface EviantaLogomarkProps extends Omit<ComponentProps<"svg">, "children"> {
  title?: string;
  tone?: "brand" | "muted";
}

type GradientStop = readonly [offset: number, color: string];

interface RibbonGradient {
  id: "outer" | "face" | "fold" | "tail" | "spark";
  from: readonly [number, number];
  to: readonly [number, number];
}

const RIBBON_GRADIENTS: readonly RibbonGradient[] = [
  { id: "outer", from: [147, 107], to: [124, 465] },
  { id: "face", from: [157, 315], to: [455, 169] },
  { id: "fold", from: [125, 279], to: [198, 470] },
  { id: "tail", from: [152, 535], to: [384, 389] },
  { id: "spark", from: [422, 318], to: [543, 378] },
];

type RibbonPalette = Record<RibbonGradient["id"], readonly GradientStop[]>;

const LIGHT_PALETTE: RibbonPalette = {
  outer: [
    [0, "hsl(178, 58%, 46%)"],
    [0.5, "hsl(182, 72%, 30%)"],
    [1, "hsl(182, 72%, 26%)"],
  ],
  face: [
    [0, "hsl(220, 26%, 14%)"],
    [0.48, "hsl(182, 72%, 26%)"],
    [1, "hsl(182, 72%, 30%)"],
  ],
  fold: [
    [0, "hsl(220, 26%, 14%)"],
    [1, "hsl(182, 72%, 26%)"],
  ],
  tail: [
    [0, "hsl(182, 72%, 30%)"],
    [0.54, "hsl(178, 58%, 46%)"],
    [1, "hsl(180, 42%, 78%)"],
  ],
  spark: [
    [0, "hsl(9, 64%, 44%)"],
    [1, "hsl(10, 86%, 70%)"],
  ],
};

const DARK_PALETTE: RibbonPalette = {
  outer: [
    [0, "hsl(180, 42%, 78%)"],
    [0.5, "hsl(178, 58%, 46%)"],
    [1, "hsl(182, 72%, 30%)"],
  ],
  face: [
    [0, "hsl(182, 72%, 26%)"],
    [0.48, "hsl(178, 58%, 46%)"],
    [1, "hsl(178, 58%, 60%)"],
  ],
  fold: [
    [0, "hsl(180, 38%, 14%)"],
    [1, "hsl(182, 72%, 30%)"],
  ],
  tail: [
    [0, "hsl(182, 72%, 30%)"],
    [0.54, "hsl(178, 58%, 46%)"],
    [1, "hsl(180, 42%, 78%)"],
  ],
  spark: [
    [0, "hsl(10, 86%, 68%)"],
    [1, "hsl(10, 86%, 80%)"],
  ],
};

// Painted in this order so the fold sits over the outer edge and the face over the fold.
const RIBBON_PATHS: ReadonlyArray<readonly [RibbonGradient["id"], string]> = [
  [
    "outer",
    "M78 468C40 432 20 384 22 320C24 230 81 153 163 110C233 73 320 70 385 111C335 93 287 112 244 145C202 177 163 214 123 254C72 305 38 389 78 468Z",
  ],
  [
    "fold",
    "M244 145C202 177 163 214 123 254C72 305 38 389 78 468C111 493 163 466 228 438C178 418 147 374 145 316C143 259 179 223 221 207Z",
  ],
  [
    "face",
    "M123 254C167 211 203 176 244 145C287 112 335 93 385 111C433 130 469 171 469 213C472 257 439 292 394 318C359 338 321 349 276 349H185C221 327 260 306 296 283C327 263 349 244 341 228C331 208 293 196 260 199C208 200 160 222 123 254Z",
  ],
  [
    "tail",
    "M78 468C114 497 172 457 228 438C275 415 318 391 358 390C407 388 444 415 461 461C424 451 397 479 353 503C292 539 233 550 181 534C138 522 103 500 78 468Z",
  ],
  [
    "spark",
    "M485 277C495 316 515 337 556 348C515 359 495 380 485 419C474 380 454 359 413 348C454 337 474 316 485 277Z",
  ],
];

function RibbonLayer({
  idPrefix,
  palette,
  className,
}: {
  idPrefix: string;
  palette: RibbonPalette;
  className: string;
}) {
  return (
    <g className={className}>
      <defs>
        {RIBBON_GRADIENTS.map(({ id, from, to }) => (
          <linearGradient
            key={id}
            id={`${idPrefix}-${id}`}
            x1={from[0]}
            y1={from[1]}
            x2={to[0]}
            y2={to[1]}
            gradientUnits="userSpaceOnUse"
          >
            {palette[id].map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {RIBBON_PATHS.map(([id, d]) => (
        <path key={id} d={d} fill={`url(#${idPrefix}-${id})`} />
      ))}
    </g>
  );
}

export function EviantaLogomark({
  title,
  tone = "brand",
  className,
  ...props
}: EviantaLogomarkProps) {
  const idPrefix = `evianta-mark-${useId().replace(/:/g, "")}`;
  const labelled = Boolean(title);
  return (
    <svg
      viewBox="18 39 542 542"
      fill="none"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn("size-8 shrink-0", tone === "muted" && "opacity-40 grayscale", className)}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <RibbonLayer idPrefix={`${idPrefix}-light`} palette={LIGHT_PALETTE} className="dark:hidden" />
      <RibbonLayer
        idPrefix={`${idPrefix}-dark`}
        palette={DARK_PALETTE}
        className="hidden dark:inline"
      />
    </svg>
  );
}

export interface EviantaWordmarkProps extends ComponentProps<"span"> {
  showMark?: boolean;
}

export function EviantaWordmark({ showMark = true, className, ...props }: EviantaWordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)} {...props}>
      {showMark ? <EviantaLogomark className="size-7" /> : null}
      <span className="text-base font-semibold tracking-tight text-foreground">Evianta</span>
    </span>
  );
}
