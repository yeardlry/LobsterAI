import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { net } from 'electron';

import { buildLitArchiveKey, LitAuthHeader } from '../../shared/paperPipeline/constants';
import type { PaperPipelineClientDeps } from './paperPipelineClient';

/**
 * Real `/lit/upload/oss` uploader (Phase 3).
 *
 * Multipart POSTs the local file to the lit backend's `LitUploadController`
 * (see `docs/MCP工具清单.md §3.1`). Archive uploads (pdf/html/word/md) must
 * pass `pmid` — the backend then keys the object as `{fileType}/{pmid}.{ext}`
 * (overwrite in place) and `submitFile` only accepts exactly that key.
 *
 * Response fields:
 *   - `data.url` IS the key (not a full URL); the orchestrator forwards it
 *     verbatim into `submitFile`.
 *   - `data.publicUrl` = OSS domain + key; use this wherever a human-facing
 *     "open in browser" URL is needed (e.g. the WeChat draft modal).
 *
 * We re-check the returned key against the expected one locally so a
 * naming mismatch fails fast here, instead of surfacing later as a
 * `submitFile` state-machine rejection with a longer error trail.
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
}): Promise<{ url: string; publicUrl?: string }> {
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

  const headers: Record<string, string> = {
    [LitAuthHeader.Name]: LitAuthHeader.Value,
  };
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

  const envelope = payload as {
    code?: number;
    data?: { url?: string; publicUrl?: string };
    msg?: string;
  };
  if (envelope.code !== 200) {
    throw new PaperPipelineUploadError(
      envelope.msg ?? `upload: lit returned code ${envelope.code ?? 'unknown'}`,
    );
  }
  if (!envelope.data?.url) {
    throw new PaperPipelineUploadError('upload: response missing data.url');
  }

  // Archive-key contract guard (see constants.ts): for pmid-keyed types the
  // backend must return exactly `{fileType}/{pmid}.{ext}`. A mismatch means
  // the backend's key rule and this client have drifted — fail before the
  // file reaches submitFile.
  const expectedKey = buildLitArchiveKey(fileType, pmid);
  if (expectedKey && envelope.data.url !== expectedKey) {
    throw new PaperPipelineUploadError(
      `upload: expected archive key ${expectedKey} (pmid=${pmid}, fileType=${fileType}) `
        + `but backend returned ${envelope.data.url}`,
    );
  }

  return {
    url: envelope.data.url,
    ...(envelope.data.publicUrl ? { publicUrl: envelope.data.publicUrl } : {}),
  };
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