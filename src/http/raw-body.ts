import type { IncomingMessage } from 'http';

/** Shared JSON body limit for the HTTP server (ADR 0019: larger bodies are backlog). */
export const JSON_BODY_LIMIT = '10mb';

/**
 * express.json `verify` hook. Keeps the exact request bytes so passthrough
 * endpoints (ADR 0019) can forward the client's body unchanged instead of a
 * JSON re-serialization (which can alter number formatting and whitespace).
 */
export function captureRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
}

export function rawBodyOf(req: unknown): Buffer | undefined {
  const raw = (req as { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? raw : undefined;
}
