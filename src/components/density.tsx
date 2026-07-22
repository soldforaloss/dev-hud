// Semantic card sizing: a card's own measured box decides how much it says,
// not the viewport. Resizing a card is an information-density control, not a
// stretch.

import { createContext, useContext, useEffect, useState } from "react";
import type { RefObject } from "react";

export type Density = "compact" | "standard" | "expanded";

/** Measured in the card's content box, in CSS px. */
export interface Breakpoints {
  compactMaxWidth: number;
  compactMaxHeight: number;
  expandedMinWidth: number;
  expandedMinHeight: number;
}

export const DEFAULT_BREAKPOINTS: Breakpoints = {
  compactMaxWidth: 250,
  compactMaxHeight: 132,
  expandedMinWidth: 400,
  expandedMinHeight: 280,
};

/**
 * Pure classifier — exported so tests can assert the breakpoint policy without
 * a DOM or a ResizeObserver.
 */
export function classifyDensity(
  width: number,
  height: number,
  bp: Breakpoints = DEFAULT_BREAKPOINTS,
): Density {
  if (width <= 0 && height <= 0) return "standard"; // not measured yet
  if (width < bp.compactMaxWidth || height < bp.compactMaxHeight) return "compact";
  if (width >= bp.expandedMinWidth && height >= bp.expandedMinHeight) return "expanded";
  return "standard";
}

/** Observe an element and classify it. Starts at "standard" until measured. */
export function useDensity(
  ref: RefObject<HTMLElement | null>,
  bp: Breakpoints = DEFAULT_BREAKPOINTS,
): Density {
  const [density, setDensity] = useState<Density>("standard");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setDensity((prev) => {
        const next = classifyDensity(box.width, box.height, bp);
        return next === prev ? prev : next;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, bp]);
  return density;
}

const DensityContext = createContext<Density>("standard");

export const DensityProvider = DensityContext.Provider;

/** Card bodies read their own density without prop drilling. */
export function useCardDensity(): Density {
  return useContext(DensityContext);
}

/** `pick({compact: a, standard: b, expanded: c})` with graceful fallback. */
export function useDensityValue<T>(choices: {
  compact?: T;
  standard?: T;
  expanded?: T;
  fallback: T;
}): T {
  const density = useCardDensity();
  if (density === "compact") return choices.compact ?? choices.standard ?? choices.fallback;
  if (density === "expanded") return choices.expanded ?? choices.standard ?? choices.fallback;
  return choices.standard ?? choices.fallback;
}

/** Row budget for list-heavy cards, by density. */
export function rowBudget(density: Density): number {
  return density === "compact" ? 3 : density === "expanded" ? 40 : 10;
}
