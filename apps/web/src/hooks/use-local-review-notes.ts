"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { OpenQuestionSeverity, OpenQuestionStatus } from "@evianta/core";

// Questions the reviewer flags from Ask. The API has no endpoint for reviewer-created questions,
// so they stay in this browser and are labelled as local notes.
export interface LocalReviewNote {
  id: string;
  text: string;
  question?: string;
  severity: OpenQuestionSeverity;
  status: OpenQuestionStatus;
  resolutionNote?: string;
  createdAt: string;
}

export interface NewLocalReviewNote {
  text: string;
  question?: string;
  severity?: OpenQuestionSeverity;
}

export interface LocalReviewNotes {
  notes: LocalReviewNote[];
  addNote: (note: NewLocalReviewNote) => LocalReviewNote;
  updateNote: (id: string, update: Pick<LocalReviewNote, "status" | "resolutionNote">) => void;
  removeNote: (id: string) => void;
}

const storagePrefix = "evianta.review-notes.";
const noNotes: LocalReviewNote[] = [];
const cache = new Map<string, LocalReviewNote[]>();
const listeners = new Set<() => void>();

function readNotes(caseId: string): LocalReviewNote[] {
  try {
    const raw = window.localStorage.getItem(`${storagePrefix}${caseId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as LocalReviewNote[]) : [];
  } catch {
    return [];
  }
}

function getNotes(caseId: string): LocalReviewNote[] {
  let notes = cache.get(caseId);
  if (!notes) {
    notes = readNotes(caseId);
    cache.set(caseId, notes);
  }

  return notes;
}

function setNotes(caseId: string, notes: LocalReviewNote[]) {
  cache.set(caseId, notes);
  try {
    if (notes.length === 0) {
      window.localStorage.removeItem(`${storagePrefix}${caseId}`);
    } else {
      window.localStorage.setItem(`${storagePrefix}${caseId}`, JSON.stringify(notes));
    }
  } catch {
    // Storage can be unavailable (private mode or quota); notes then last for this visit only.
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(storagePrefix)) {
      cache.delete(event.key.slice(storagePrefix.length));
      listener();
    }
  };

  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function createNoteId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `note-${crypto.randomUUID()}`
    : `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useLocalReviewNotes(caseId: string): LocalReviewNotes {
  const notes = useSyncExternalStore(
    subscribe,
    () => getNotes(caseId),
    () => noNotes,
  );

  const addNote = useCallback(
    (input: NewLocalReviewNote) => {
      const note: LocalReviewNote = {
        id: createNoteId(),
        text: input.text,
        question: input.question,
        severity: input.severity ?? "medium",
        status: "open",
        createdAt: new Date().toISOString(),
      };
      setNotes(caseId, [...getNotes(caseId), note]);
      return note;
    },
    [caseId],
  );

  const updateNote = useCallback(
    (id: string, change: Pick<LocalReviewNote, "status" | "resolutionNote">) => {
      setNotes(
        caseId,
        getNotes(caseId).map((note) => (note.id === id ? { ...note, ...change } : note)),
      );
    },
    [caseId],
  );

  const removeNote = useCallback(
    (id: string) => {
      setNotes(
        caseId,
        getNotes(caseId).filter((note) => note.id !== id),
      );
    },
    [caseId],
  );

  return { notes, addNote, updateNote, removeNote };
}
