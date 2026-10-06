import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { net } from 'electron';

import { buildLitArchiveKey, LitAuthHeader } from '../../shared/paperPipeline/constants';
import type { PaperPipelineClientDeps } from './paperPipelineClient';

const IMAGE_EXTENSIONS = new Set(['bmp', 'gif', 'jpg', 'jpeg', 'png']);

const IMAGE_MIME_TYPES: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

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
  /** Optional exact UTF-8 content to upload instead of rereading localPath. */
  content?: string;
  /** Multipart filename override, useful when content is generated in memory. */
  fileName?: string;
  clientDeps: PaperPipelineClientDeps;
}): Promise<{ url: string; publicUrl?: string }> {
  const { clientDeps, pmid, fileType, localPath } = input;

  if (!clientDeps) {
    throw new PaperPipelineUploadError('uploadFile requires clientDeps');
  }

  const fileBytes = input.content === undefined
    ? await fsp.readFile(localPath)
    : Buffer.from(input.content, 'utf8');
  const filename = input.fileName ?? path.basename(localPath);

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

/** Upload a generated figure to Qiniu via `/lit/upload/image`. */
export async function uploadImageFile(input: {
  pmid: string;
  localPath: string;
  clientDeps: PaperPipelineClientDeps;
}): Promise<{ key: string; fileName: string; url: string; publicUrl: string }> {
  const { clientDeps, localPath, pmid } = input;
  const fileName = path.basename(localPath);
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new PaperPipelineUploadError(`image upload: unsupported extension .${extension || 'unknown'}`);
  }

  const fileBytes = await fsp.readFile(localPath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(fileBytes)], { type: IMAGE_MIME_TYPES[extension] }),
    fileName,
  );
  // The image endpoint derives `image/{pmid}/...` on the server. Do not send
  // `dir`: the backend contract requires the PMID as multipart form data.
  form.append('pmid', pmid);

  const headers: Record<string, string> = {
    [LitAuthHeader.Name]: LitAuthHeader.Value,
  };
  const token = clientDeps.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await net.fetch(`${clientDeps.getBaseUrl()}/lit/upload/image`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!response.ok) {
    throw new PaperPipelineUploadError(
      `image upload failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new PaperPipelineUploadError('image upload: failed to parse JSON response', { cause: err });
  }
  const envelope = payload as {
    code?: number;
    msg?: string;
    data?: { key?: string; fileName?: string; url?: string; publicUrl?: string };
  };
  if (envelope.code !== 200) {
    throw new PaperPipelineUploadError(
      envelope.msg ?? `image upload: lit returned code ${envelope.code ?? 'unknown'}`,
    );
  }
  const data = envelope.data;
  if (!data?.key || !data.fileName || !data.url || !data.publicUrl) {
    throw new PaperPipelineUploadError('image upload: response missing key/fileName/url/publicUrl');
  }
  if (!data.key.startsWith(`image/${pmid}/`)) {
    throw new PaperPipelineUploadError(
      `image upload: backend returned unexpected key ${data.key}`,
    );
  }
  return {
    key: data.key,
    fileName: data.fileName,
    url: data.url,
    publicUrl: data.publicUrl,
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
