import { useCaseSchema, type Case, type DocumentMetadata } from "@evianta/core";
import { detectDocumentFormat, SUPPORTED_MIME_TYPES } from "@evianta/ingest";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import { loadCaseStateAsync, toDocumentView } from "../caseState.js";
import { getCaseOrThrowAsync, getMutableCaseAsync, type ApiContext } from "../context.js";
import { ApiError, notFoundError, toApiError } from "../errors.js";
import {
  asyncRoute,
  caseParamsSchema,
  contentDisposition,
  documentParamsSchema,
  requireVisitorId,
} from "../http.js";

const createCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    useCase: useCaseSchema,
  })
  .strict();

const UPLOAD_FIELDS = new Set(["file", "files"]);
const SUPPORTED_MIME_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_MIME_TYPES);
const MAX_FILE_NAME_LENGTH = 255;

function newestFirst(left: Case, right: Case): number {
  return right.createdAt.localeCompare(left.createdAt);
}

// Browsers send UTF-8 file names, which multipart parsing reads as latin1 by default.
function decodeFileName(originalName: string): string {
  const decoded = Buffer.from(originalName, "latin1").toString("utf8");
  const name = decoded.includes("\uFFFD") ? originalName : decoded;

  return name.trim().slice(-MAX_FILE_NAME_LENGTH) || "document";
}

interface ValidatedUpload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

function validateUpload(file: Express.Multer.File): ValidatedUpload {
  const name = decodeFileName(file.originalname);

  if (!UPLOAD_FIELDS.has(file.fieldname)) {
    throw new ApiError(400, "unexpected-file-field", 'Send files in the "files" field.');
  }

  if (file.size === 0) {
    throw new ApiError(400, "empty-file", `"${name}" is empty.`);
  }

  const detected = detectDocumentFormat(file.buffer, { mimeType: file.mimetype, name });

  if (!SUPPORTED_MIME_TYPE_SET.has(detected.mimeType)) {
    throw new ApiError(415, "unsupported-media-type", `"${name}" is not a supported file type.`);
  }

  return { name, mimeType: detected.mimeType, buffer: file.buffer };
}

export function createCaseRoutes(ctx: ApiContext): Router {
  const router = Router();
  const { store } = ctx;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: ctx.config.maxUploadBytes,
      files: ctx.config.maxFilesPerUpload,
      fields: 20,
    },
  }).any();

  function parseUploadAsync(req: Request, res: Response): Promise<Express.Multer.File[]> {
    return new Promise((resolve, reject) => {
      upload(req, res, (error: unknown) => {
        if (error) {
          reject(
            toApiError(error) ??
              new ApiError(400, "invalid-upload", "The multipart upload could not be read."),
          );

          return;
        }

        resolve(Array.isArray(req.files) ? req.files : []);
      });
    });
  }

  router.post(
    "/cases",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);
      const body = createCaseSchema.parse(req.body);
      const created = await store.cases.createCaseAsync({ ...body, visitorId });

      res
        .status(201)
        .location(`/cases/${encodeURIComponent(created.id)}`)
        .json(created);
    }),
  );

  router.get(
    "/cases",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);
      const cases = await store.cases.listCasesForVisitorAsync(visitorId);

      res.json({ cases: cases.filter((item) => !item.isSample).sort(newestFirst) });
    }),
  );

  router.get(
    "/samples",
    asyncRoute(async (_req, res) => {
      const samples = await store.cases.listSampleCasesAsync();

      res.json({ cases: samples });
    }),
  );

  router.post(
    "/cases/:caseId/copy",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const visitorId = requireVisitorId(req);
      const source = await getCaseOrThrowAsync(ctx, caseId);

      if (!source.isSample) {
        throw new ApiError(422, "not-a-sample", "Only sample cases can be copied.");
      }

      const copy = await store.cases.copyCaseAsync(source.id, visitorId);

      res
        .status(201)
        .location(`/cases/${encodeURIComponent(copy.id)}`)
        .json(copy);
    }),
  );

  router.get(
    "/cases/:caseId",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const state = await loadCaseStateAsync(store, ctx.ingestion, ctx.runs, caseId);

      if (!state) {
        throw notFoundError("case");
      }

      res.json(state);
    }),
  );

  router.post(
    "/cases/:caseId/documents",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      // Registered before the checks so a run cannot start between them and the stored metadata.
      const endUpload = ctx.uploads.begin(caseId);
      const documents: DocumentMetadata[] = [];

      try {
        await getMutableCaseAsync(ctx, caseId);

        if (ctx.runs.isActive(caseId)) {
          throw new ApiError(
            409,
            "run-in-progress",
            "Wait for the run to finish before uploading.",
          );
        }

        // Completed tasks are reused by later runs, so documents added after planning would be ignored.
        if ((await store.tasks.getTasksForCaseAsync(caseId)).length > 0) {
          throw new ApiError(
            409,
            "case-already-planned",
            "Documents cannot be added after the case has been planned. Start a new case to use different documents.",
          );
        }

        const files = await parseUploadAsync(req, res);

        if (files.length === 0) {
          throw new ApiError(
            400,
            "no-files",
            'Send one or more files as multipart/form-data in the "files" field.',
          );
        }

        const uploads = files.map(validateUpload);

        for (const item of uploads) {
          const gcsPath = await ctx.documentStore.uploadAsync(
            caseId,
            item.name,
            item.mimeType,
            item.buffer,
          );

          documents.push(
            await store.documents.addDocumentMetadataAsync({
              id: ctx.newId(),
              caseId,
              name: item.name,
              mimeType: item.mimeType,
              size: item.buffer.length,
              gcsPath,
              uploadedAt: ctx.now().toISOString(),
            }),
          );
        }
      } finally {
        endUpload();
      }

      for (const document of documents) {
        ctx.ingestion.enqueue(document);
      }

      res.status(201).json({
        documents: documents.map((document) => toDocumentView(document, undefined, ctx.ingestion)),
      });
    }),
  );

  router.get(
    "/cases/:caseId/documents/:documentId",
    asyncRoute(async (req, res) => {
      const { caseId, documentId } = documentParamsSchema.parse(req.params);
      const metadata = await store.documents.getDocumentAsync(caseId, documentId);

      if (!metadata) {
        throw notFoundError("document");
      }

      const stored = await store.documents.getExtractionAsync(caseId, documentId);
      const extraction = stored ?? ctx.ingestion.stateOf(caseId, documentId)?.extraction;

      res.json({
        document: toDocumentView(metadata, stored, ctx.ingestion),
        ...(extraction ? { extraction } : {}),
      });
    }),
  );

  router.get(
    "/cases/:caseId/documents/:documentId/file",
    asyncRoute(async (req, res) => {
      const { caseId, documentId } = documentParamsSchema.parse(req.params);
      const metadata = await store.documents.getDocumentAsync(caseId, documentId);

      if (!metadata) {
        throw notFoundError("document");
      }

      const bytes = await ctx.documentStore.readBufferAsync(metadata.gcsPath);

      res.setHeader("Content-Type", metadata.mimeType);
      res.setHeader("Content-Disposition", contentDisposition("inline", metadata.name));
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(bytes);
    }),
  );

  return router;
}
