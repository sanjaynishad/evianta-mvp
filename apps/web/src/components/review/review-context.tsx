"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Finding } from "@evianta/core";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import type { EvidenceEntry } from "@/lib/evidence";
import { motionDurationMs } from "@/lib/motion";
import { findingDomId, sectionDomId } from "@/lib/review";

export type ReviewPanel = "evidence" | "ask";

export interface EvidenceTarget {
  // Increments on every open, so reopening the same evidence pulses the highlight again.
  requestId: number;
  documentId?: string;
  evidenceId?: string;
}

export interface SourceSelection {
  documentId: string;
  label: string;
  evidenceIds: string[];
  sheetRow?: { sheet: string; row: number };
}

export interface ReviewContextValue {
  caseId: string;
  evidenceIndex: Map<string, EvidenceEntry>;
  findingsById: Map<string, Finding>;
  target: EvidenceTarget | undefined;
  panel: ReviewPanel;
  setPanel: (panel: ReviewPanel) => void;
  openEvidence: (evidenceId: string) => void;
  openDocument: (documentId: string) => void;
  closeSource: () => void;
  selection: SourceSelection | undefined;
  setSelection: (selection: SourceSelection | undefined) => void;
  isEvidenceHighlighted: (evidenceId: string) => boolean;
  focusFinding: (findingId: string) => void;
  focusSection: (sectionId: string) => void;
  focusElement: (domId: string) => void;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

const overlayCloseDelayMs = motionDurationMs.base;

export interface ReviewProviderProps {
  caseId: string;
  evidenceIndex: Map<string, EvidenceEntry>;
  findings: Finding[];
  // Called when the side panel has to become visible, for example inside a sheet on small screens.
  onRevealPanel?: (panel: ReviewPanel) => void;
  // Called before scrolling the main content; returns true when overlays had to close first.
  onNavigate?: () => boolean;
  children: ReactNode;
}

export function ReviewProvider({
  caseId,
  evidenceIndex,
  findings,
  onRevealPanel,
  onNavigate,
  children,
}: ReviewProviderProps) {
  const { reduced } = useMotionSafe();
  const [target, setTarget] = useState<EvidenceTarget>();
  const [panel, setPanelState] = useState<ReviewPanel>("evidence");
  const [selection, setSelection] = useState<SourceSelection>();
  const findingsById = useMemo(
    () => new Map(findings.map((finding) => [finding.id, finding])),
    [findings],
  );

  const setPanel = useCallback(
    (next: ReviewPanel) => {
      setPanelState(next);
      onRevealPanel?.(next);
    },
    [onRevealPanel],
  );

  const openEvidence = useCallback(
    (evidenceId: string) => {
      const entry = evidenceIndex.get(evidenceId);
      setTarget((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        evidenceId,
        documentId: entry?.document?.id ?? entry?.evidence.documentId,
      }));
      setSelection(undefined);
      setPanel("evidence");
    },
    [evidenceIndex, setPanel],
  );

  const openDocument = useCallback(
    (documentId: string) => {
      setTarget((current) => ({ requestId: (current?.requestId ?? 0) + 1, documentId }));
      setSelection(undefined);
      setPanel("evidence");
    },
    [setPanel],
  );

  const closeSource = useCallback(() => {
    setTarget((current) => (current ? { requestId: current.requestId + 1 } : current));
    setSelection(undefined);
  }, []);

  const focusElement = useCallback(
    (domId: string) => {
      const scrollToTarget = () => {
        const element = document.getElementById(domId);
        if (!element) {
          return;
        }

        element.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
        element.focus({ preventScroll: true });
      };

      if (onNavigate?.()) {
        window.setTimeout(scrollToTarget, overlayCloseDelayMs);
      } else {
        scrollToTarget();
      }
    },
    [reduced, onNavigate],
  );

  const value = useMemo<ReviewContextValue>(
    () => ({
      caseId,
      evidenceIndex,
      findingsById,
      target,
      panel,
      setPanel,
      openEvidence,
      openDocument,
      closeSource,
      selection,
      setSelection,
      isEvidenceHighlighted: (evidenceId) =>
        target?.evidenceId === evidenceId || Boolean(selection?.evidenceIds.includes(evidenceId)),
      focusFinding: (findingId) => focusElement(findingDomId(findingId)),
      focusSection: (sectionId) => focusElement(sectionDomId(sectionId)),
      focusElement,
    }),
    [
      caseId,
      evidenceIndex,
      findingsById,
      target,
      panel,
      setPanel,
      openEvidence,
      openDocument,
      closeSource,
      selection,
      focusElement,
    ],
  );

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const context = useContext(ReviewContext);
  if (!context) {
    throw new Error("useReview must be used inside a ReviewProvider");
  }

  return context;
}

export function useOptionalReview(): ReviewContextValue | null {
  return useContext(ReviewContext);
}
