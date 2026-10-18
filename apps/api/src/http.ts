import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { ApiError } from "./errors.js";

export const VISITOR_HEADER = "X-Evianta-Visitor";

export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export const idSchema = z.string().trim().min(1).max(200);

export const caseParamsSchema = z.object({ caseId: idSchema });

export const documentParamsSchema = caseParamsSchema.extend({ documentId: idSchema });

export const deliverableParamsSchema = caseParamsSchema.extend({ deliverableId: idSchema });

export const sectionParamsSchema = deliverableParamsSchema.extend({ sectionId: idSchema });

export const questionParamsSchema = caseParamsSchema.extend({ questionId: idSchema });

/** A Content-Disposition value with an ASCII fallback and the UTF-8 file name. */
export function contentDisposition(type: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const visitorIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, hyphens, or underscores.");

/** The anonymous visitor id is a convenience scope for listing cases, not an access control. */
export function requireVisitorId(req: Request): string {
  const parsed = visitorIdSchema.safeParse(req.get(VISITOR_HEADER));

  if (!parsed.success) {
    throw new ApiError(
      400,
      "visitor-required",
      `Send the anonymous visitor id in the ${VISITOR_HEADER} header.`,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: ["headers", VISITOR_HEADER],
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }

  return parsed.data;
}

/** The visitor id when a valid one was sent; used to scope optional data-source lookups. */
export function optionalVisitorId(req: Request): string | undefined {
  const parsed = visitorIdSchema.safeParse(req.get(VISITOR_HEADER));

  return parsed.success ? parsed.data : undefined;
}
