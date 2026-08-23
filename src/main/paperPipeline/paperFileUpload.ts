import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { net } from 'electron';

import type { PaperPipelineClientDeps } from './paperPipelineClient';

/**
 * Real `/lit/upload/oss` uploader (Phase 3).
 *
 * Multipart POSTs the local PDF to the lit backend's `LitUploadController`
 * (see `docs/MCP工具清单.md §3.1`) and returns the public OSS URL the
 * controller hands back. The orchestrator then forwards this URL into
 * `submitFile(pmid, 'pdf', url)` so the backend stores `pdf_url`.
 *
 * Requires `clientDeps` to be supplied. If it isn't, we throw — Phase 1's
 * stub `https://stub.lit.local/...` URL no longer exists.
 */
export async function uploadFile(input: {
  pmid: string;
  fileType: string;
  localPath: string;
  bytes: number;
  clientDeps: PaperPipelineClientDeps;
}): Promise<{ url: string }> {
  const { clientDeps, pmid, fileType, localPath } = input;

  if (!clientDeps) {
    throw new PaperPipelineUploadError('uploadFile requires clientDeps');
  }

  const fileBytes = await fsp.readFile(localPath);
  const filename = path.basename(localPath);

  const form = new FormData();
  form.append('pmid', pmid);
  form.append('fileType', fileType);
  form.append(
    'file',
    new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }),
    filename,
  );

  const headers: Record<string, string> = {};
  const token = clientDeps.getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await net.fetch(`${clientDeps.getBaseUrl()}/lit/upload/oss`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    throw new PaperPipelineUploadError(
      `upload failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new PaperPipelineUploadError('upload: failed to parse JSON response', {
      cause: err,
    });
  }

  const envelope = payload as { code?: number; data?: { url?: string }; msg?: string };
  if (envelope.code !== 200) {
    throw new PaperPipelineUploadError(
      envelope.msg ?? `upload: lit returned code ${envelope.code ?? 'unknown'}`,
    );
  }
  if (!envelope.data?.url) {
    throw new PaperPipelineUploadError('upload: response missing data.url');
  }

  return { url: envelope.data.url };
}

export class PaperPipelineUploadError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'PaperPipelineUploadError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}