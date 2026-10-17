import type { RequestHandler } from "express";

const ALLOWED_METHODS = "GET, POST, PATCH, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Last-Event-ID, X-Evianta-Visitor";
const EXPOSED_HEADERS = "Content-Disposition, Location";

/** Allows cross-origin calls from the configured web origins only; no credentials are used. */
export function createCorsMiddleware(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);

  return (req, res, next) => {
    const origin = req.get("Origin");
    const isAllowed = origin !== undefined && allowed.has(origin);

    res.vary("Origin");

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }

    if (req.method === "OPTIONS" && req.get("Access-Control-Request-Method")) {
      if (!isAllowed) {
        res.status(403).end();

        return;
      }

      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();

      return;
    }

    next();
  };
}
