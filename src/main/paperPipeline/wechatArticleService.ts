import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LitArchiveFileType } from '../../shared/paperPipeline/constants';
import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { uploadFile, uploadImageFile } from './paperFileUpload';
import type { PaperPipelineClientDeps } from './paperPipelineClient';
import { PaperPipelineClient } from './paperPipelineClient';
import {
  ensurePaperPipelineDirs,
  getPaperPipelineArtifactPath,
  getPaperPipelineHtmlPath,
  getPaperPipelinePdfPath,
  getPaperPipelineXmlPath,
} from './storage';
import { clearTaskHiddenSession, runTaskHiddenSession, stopTaskHiddenSession } from './taskHiddenSession';
import { extractDraftMeta } from './wechatDraftMeta';
import { buildGenerationPrompt } from './wechatGenerationPrompt';

/**
 * WeChat article generator (manual paste workflow).
 *
 * We do NOT call the WeChat Open API from LobsterAI — LobsterAI has no
 * access to the user's WeChat 公众号 credentials. Instead we:
 *
 *   1. Ask a hidden Cowork session (same agent / tools as a normal chat)
 *      to read the article's full text — the downloaded PDF when it is
 *      still in the local cache, else the closed-access HTML landing page
 *      (`html/{pmid}.html`, see the download service's fallback), else the
 *      cached PMC XML (title/abstract only) — and write
 *      a publication-ready, figure-rich Chinese Markdown article to
 *      `app.getPath('userData')/paperPipeline/wechat/wechat-<pmid>.md`,
 *      with figures extracted into a sibling `wechat-<pmid>-assets/` dir.
 *   2. The renderer pops a modal that shows the draft title/summary and
 *      asks the user to copy the content into the 微信公众平台 编辑器
 *      themselves, then paste the resulting `https://mp.weixin.qq.com/s/...`
 *      docUrl back into the same modal. Only then does the UI call
 *      `submitWechatDoc(pmid, docUrl, extras)` to push the task to
 *      `completed`.
 *
 * If the hidden session is unavailable (deps not wired), fails, or
 * produces no usable file, we fall back to the deterministic local
 * template so the state machine never breaks on this step.
 *
 * The finished Markdown (generated or template) is uploaded to OSS under
 * the archive-key contract as `md/{pmid}.md`; the upload response's
 * `publicUrl` (OSS domain + key) becomes `markdownUrl`, so the modal's
 * "open in browser" button and the `submitWechatDoc` extras carry a real
 * URL. When the upload fails or `clientDeps` is not wired we degrade to a
 * local `file://` path — the modal's copy-path workflow still works.
 *
 * A second hidden session converts the Markdown to a Word document
 * (embedded figures included), which is archived at `word/{pmid}.docx`
 * and registered via `submitFile(fileType=word)` so the backend records
 * `word_url`. Only `pdf` advances the state machine, so the word submit
 * is a pure column write. Everything here is best-effort: a failed
 * conversion/upload logs a warning and never breaks the step.
 */

export interface WechatDraft {
  localMarkdownPath: string;
  markdownUrl: string;
  renderedTitle: string;
  renderedSummary: string;
}

/** Session deps needed to drive the hidden Cowork session. */
export interface WechatDraftDeps {
  coworkRuntime?: CoworkRuntime | null;
  coworkStore?: CoworkStore | null;
  resolveAgentCwd?: ((agentId: string) => string) | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Generated drafts must beat this length or we treat them as failures. */
const MIN_GENERATED_MARKDOWN_CHARS = 300;

export async function prepareWechatDraft(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  categoryIds: string[];
  tagIds: string[];
  pdfUrl: string | null;
  deps?: WechatDraftDeps;
  clientDeps?: PaperPipelineClientDeps;
  /**
   * Override agent id for the hidden sessions (article draft + word
   * export). Falls back to the global `main` agent when omitted; the
   * auto-advance orchestrator threads an installed-expert id through
   * here so the drafter uses biology-tuned voice + skills.
   */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref) threaded from
   * `PaperPipelineModelConfig.pipelineModel`. `undefined` keeps the agent's
   * own binding.
   */
  modelOverride?: string;
}): Promise<WechatDraft> {
  const templateTitle = buildTitle(input);
  const templateSummary = input.extSummary || '(暂无 extSummary，请人工补一段导语)';
  const filename = `wechat-${input.pmid}.md`;
  await ensurePaperPipelineDirs();
  const localPath = getPaperPipelineArtifactPath('wechat', filename);

  let renderedTitle = templateTitle;
  let renderedSummary = templateSummary;

  const generated = await tryGenerateWithAgent(
    input,
    localPath,
    input.agentId,
    input.modelOverride,
  );
  if (generated) {
    const markdown = await fs.readFile(localPath, 'utf-8');
    const meta = extractDraftMeta(markdown);
    renderedTitle = meta.title ?? templateTitle;
    renderedSummary = meta.summary ?? templateSummary;
  } else {
    // Fallback: deterministic template (original Phase 4 stub body).
    console.warn(
      `[WechatDraft] Markdown Agent did not produce a draft for PMID ${input.pmid}; using template fallback`,
    );
    const markdown = renderMarkdown({
      pmid: input.pmid,
      title: templateTitle,
      summary: templateSummary,
      extSummary: input.extSummary,
      authors: input.authors,
      categoryIds: input.categoryIds,
      tagIds: input.tagIds,
      pdfUrl: input.pdfUrl,
    });
    await fs.writeFile(localPath, markdown, 'utf8');
  }

  const publishedMarkdown = await createPublishedMarkdown(
    input.pmid,
    localPath,
    input.clientDeps,
  );
  const publicUrl = await tryUploadDraft(
    input.pmid,
    publishedMarkdown.sourcePath,
    input.clientDeps,
    publishedMarkdown.content,
  );

  // Word export (best-effort): hidden session converts the finished
  // Markdown, then we archive it at word/{pmid}.docx and record word_url.
  const docxPath = await tryExportWordDocx(
    input,
    localPath,
    input.agentId,
    input.modelOverride,
  );
  if (docxPath) {
    await tryUploadWordDocx(input.pmid, docxPath, input.clientDeps);
  }

  return {
    localMarkdownPath: localPath,
    markdownUrl: publicUrl ?? `file://${localPath}`,
    renderedTitle,
    renderedSummary,
  };
}

/**
 * Upload the finished draft as `md/{pmid}.md`, register the archive key via
 * `submitFile(fileType=md)`, and return the public OSS URL. Best-effort: on
 * any failure we log and return null so the caller degrades to the local
 * `file://` path instead of breaking the step.
 */
async function tryUploadDraft(
  pmid: string,
  localPath: string,
  clientDeps: PaperPipelineClientDeps | undefined,
  markdownContent: string,
): Promise<string | null> {
  if (!clientDeps) return null;
  try {
    const hasLocalImageReference = /!\[[^\]]*\]\(\s*(?!https?:|data:|#)[^\s)>]+|<img\b[^>]*\bsrc\s*=\s*["'](?!https?:|data:|#)[^"']+["']/i.test(markdownContent);
    if (hasLocalImageReference) {
      throw new Error('refusing to upload Markdown that still contains a local image reference');
    }
    const uploaded = await uploadFile({
      pmid,
      fileType: LitArchiveFileType.Md,
      localPath,
      bytes: Buffer.byteLength(markdownContent, 'utf8'),
      content: markdownContent,
      fileName: path.basename(localPath),
      clientDeps,
    });
    // `uploaded.url` is the archive key (`md/{pmid}.md`) required by the
    // backend submit endpoint. Never pass `publicUrl` here: it is only for
    // human-facing links and is rejected by the archive-key contract.
    await new PaperPipelineClient(clientDeps).submitFile(
      pmid,
      LitArchiveFileType.Md,
      uploaded.url,
    );
    console.log(`[WechatDraft] publish Markdown uploaded from in-memory rewritten content to ${uploaded.url} (public: ${uploaded.publicUrl ?? 'n/a'})`);
    return uploaded.publicUrl ?? null;
  } catch (err) {
    console.warn(
      `[WechatDraft] markdown upload failed for PMID ${pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    return null;
  }
}

/**
 * Create the publish copy of Markdown. Local Markdown keeps relative paths so
 * Word conversion can embed the files; the uploaded copy must point at the
 * public Qiniu URLs instead of the user's local filesystem.
 */
async function createPublishedMarkdown(
  pmid: string,
  localPath: string,
  clientDeps: PaperPipelineClientDeps | undefined,
): Promise<{ sourcePath: string; content: string }> {
  const markdown = await fs.readFile(localPath, 'utf8');
  if (!clientDeps) return { sourcePath: localPath, content: markdown };

  // Accept normal Markdown (including an optional title) and simple HTML
  // images. The Agent is instructed to use the assets directory, but older
  // runs may have written figures beside the Markdown file instead.
  const imagePattern = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const artifactRoot = path.resolve(path.dirname(localPath));
  const resolvedUrls = new Map<string, Promise<string | null>>();
  const replacements: Array<{ whole: string; replacement: string }> = [];
  let discoveredImages = 0;
  let uploadedImages = 0;

  for (const match of markdown.matchAll(imagePattern)) {
    const whole = match[0];
    const alt = match[1] || '图片';
    const reference = match[2] || match[3] || '';
    if (/^(?:https?:|data:|#)/i.test(reference)) continue;

    discoveredImages += 1;
    let decodedReference = reference;
    try {
      decodedReference = reference.startsWith('file:')
        ? fileURLToPath(reference)
        : decodeURIComponent(reference);
    } catch {
      // Keep the original path; uploadImageFile will report a useful failure.
    }
    const resolved = path.resolve(path.dirname(localPath), decodedReference);
    const isInsideArtifact = resolved.startsWith(`${artifactRoot}${path.sep}`)
      && resolved !== path.resolve(localPath);
    if (!isInsideArtifact) {
      replacements.push({ whole, replacement: `*${alt}（图片路径不在文章工作目录，未上传）*` });
      continue;
    }

    let publicUrlPromise = resolvedUrls.get(resolved);
    if (!publicUrlPromise) {
      publicUrlPromise = uploadImageFile({ pmid, localPath: resolved, clientDeps })
        .then(uploaded => uploaded.publicUrl)
        .catch((err): string | null => {
          console.warn(
            `[WechatDraft] image upload failed for PMID ${pmid}, ${reference}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
          return null;
        });
      resolvedUrls.set(resolved, publicUrlPromise);
    }
    const publicUrl = await publicUrlPromise;
    if (publicUrl) uploadedImages += 1;
    replacements.push({
      whole,
      replacement: publicUrl ? `![${alt}](${publicUrl})` : `*${alt}（图片上传失败）*`,
    });
  }

  if (discoveredImages > 0) {
    console.log(
      `[WechatDraft] image processing for PMID ${pmid}: discovered ${discoveredImages}, uploaded ${uploadedImages}; local paths are replaced before Markdown upload`,
    );
  }
  if (replacements.length === 0) return { sourcePath: localPath, content: markdown };
  let published = markdown;
  for (const { whole, replacement } of replacements) {
    published = published.replace(whole, replacement);
  }
  console.log(`[WechatDraft] in-memory publish Markdown prepared from ${localPath}; local image references rewritten: ${replacements.length}`);
  return { sourcePath: localPath, content: published };
}

/**
 * Drive a hidden Cowork session to convert the finished Markdown into a
 * Word document at `wechat-<pmid>.docx`. No bundled converter — the agent
 * uses whatever the machine offers (pandoc, python-docx, ...), same as it
 * would in a normal chat.
 *
 * Returns the docx path iff the session reported DONE AND the file on
 * disk looks like a real docx (ZIP magic + non-trivial size) — the claim
 * alone is not evidence. Best-effort: null on any failure.
 */
async function tryExportWordDocx(
  input: { pmid: string; deps?: WechatDraftDeps },
  mdPath: string,
  agentId?: string,
  modelOverride?: string,
): Promise<string | null> {
  const { coworkRuntime, coworkStore, resolveAgentCwd, log } = input.deps ?? {};
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    log ?? ((level, message) => console[level](message));
  if (!coworkRuntime || !coworkStore || !resolveAgentCwd) {
    logSink('warn', '[WechatDraft] hidden-session deps not wired, skipping word export');
    return null;
  }

  const docxPath = getPaperPipelineArtifactPath('wechat', `wechat-${input.pmid}.docx`);
  try {
    const result = await runTaskHiddenSession(
      input.pmid,
      {
        prompt: buildWordExportPrompt(input.pmid, mdPath, docxPath),
        agentId: agentId ?? 'main',
        modelOverride,
        // Local conversion, but the agent may need to probe for / install
        // a converter first (pandoc, python-docx) — 3 minutes is roomy
        // without letting a hung run park the step for the full 5-minute
        // cap.
        timeoutMs: 180 * 1000,
      },
      { runtime: coworkRuntime, store: coworkStore, resolveAgentCwd, log },
    );
    if (!result.finalText.includes('DONE')) {
      logSink('warn', `[WechatDraft] word export agent did not report DONE for PMID ${input.pmid}: ${result.finalText.slice(0, 200)}`);
      return null;
    }

    // A .docx is a ZIP archive — it must start with the `PK` magic and
    // beat 1KB, otherwise the agent "converted" into garbage or HTML.
    const stat = await fs.stat(docxPath).catch((): null => null);
    if (!stat || stat.size <= 1024) {
      logSink('warn', `[WechatDraft] word export for PMID ${input.pmid} produced no usable file (${stat?.size ?? 0} bytes)`);
      return null;
    }
    const handle = await fs.open(docxPath, 'r');
    try {
      const head = Buffer.alloc(2);
      await handle.read(head, 0, 2, 0);
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        logSink('warn', `[WechatDraft] word export for PMID ${input.pmid} is not a ZIP/docx (magic ${head.toString('hex')})`);
        return null;
      }
    } finally {
      await handle.close();
    }
    logSink('info', `[WechatDraft] word export ready for PMID ${input.pmid} (${stat.size} bytes)`);
    return docxPath;
  } catch (err) {
    logSink('warn', `[WechatDraft] word export session failed for PMID ${input.pmid}: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}

function buildWordExportPrompt(pmid: string, mdPath: string, docxPath: string): string {
  return [
    '请只把这个 Markdown 文件转换成 Word（.docx）文档，不要修改文章事实内容：',
    `- 源文件（UTF-8）：${mdPath}`,
    `- 输出路径（覆盖已有文件）：${docxPath}`,
    '',
    '要求：',
    '1. 保留标题层级、加粗、列表、引用、表格等格式；不得总结、润色、翻译、删减或重新组织 Markdown 文字、数字和结论；',
    `2. Markdown 中以相对路径引用的本地图片（如有，位于源文件同目录的 wechat-${pmid}-assets/ 等子目录）必须检查文件是否存在并尽可能嵌入 Word；图片不存在时保留文字说明，并在失败原因中报告；不要使用外部图片或自行生成图片；`,
    '3. 只能使用当前环境已经存在的工具（pandoc、python-docx 等）完成转换，不要安装依赖或修改系统环境；',
    '4. 完成后检查 docx 存在、可解析、正文非空、标题层级基本保留，并尽可能确认本地图片已嵌入；检查通过后只回复一行 DONE，失败回复一行 FAILED: 原因。',
  ].join('\n');
}

/**
 * Archive the Word draft at `word/{pmid}.docx` and register it via
 * `submitFile(fileType=word)` so the backend records `word_url`. Only
 * `pdf` advances the state machine, so this submit is a pure column
 * write. Best-effort: failures log a warning and never break the step.
 */
async function tryUploadWordDocx(
  pmid: string,
  docxPath: string,
  clientDeps: PaperPipelineClientDeps | undefined,
): Promise<void> {
  if (!clientDeps) return;
  try {
    const { size } = await fs.stat(docxPath);
    const uploaded = await uploadFile({
      pmid,
      fileType: LitArchiveFileType.Word,
      localPath: docxPath,
      bytes: size,
      clientDeps,
    });
    await new PaperPipelineClient(clientDeps).submitFile(pmid, LitArchiveFileType.Word, uploaded.url);
    console.log(`[WechatDraft] word draft archived at ${uploaded.url}`);
  } catch (err) {
    console.warn(
      `[WechatDraft] word draft upload/submit failed for PMID ${pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Drive a hidden Cowork session to write the article. Returns true iff the
 * session claimed success AND a plausible Markdown file landed at
 * `localPath` (the claim alone is not evidence — same policy as the
 * agent-downloaded PDF). Errors are logged and swallowed: the caller
 * falls back to the local template.
 */
async function tryGenerateWithAgent(
  input: {
    pmid: string;
    extSummary: string;
    authors: PaperTaskAuthor[];
    categoryIds: string[];
    tagIds: string[];
    deps?: WechatDraftDeps;
  },
  localPath: string,
  agentId?: string,
  modelOverride?: string,
): Promise<boolean> {
  const { coworkRuntime, coworkStore, resolveAgentCwd, log } = input.deps ?? {};
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    log ?? ((level, message) => console[level](message));
  if (!coworkRuntime || !coworkStore || !resolveAgentCwd) {
    logSink('warn', '[WechatDraft] hidden-session deps not wired, using template fallback');
    return false;
  }

  // Source resolution, by priority: the downloaded PDF is the primary full
  // text; the closed-access HTML landing page takes over when no OA PDF
  // exists; the cached PMC XML (title/abstract only) is the last resort.
  const pdfPath = getPaperPipelinePdfPath(input.pmid);
  const htmlPath = getPaperPipelineHtmlPath(input.pmid);
  const xmlPath = getPaperPipelineXmlPath(input.pmid);
  const [hasPdf, hasHtml, hasXml] = await Promise.all([
    fs.access(pdfPath).then(() => true, () => false),
    fs.access(htmlPath).then(() => true, () => false),
    fs.access(xmlPath).then(() => true, () => false),
  ]);
  if (!hasPdf && !hasHtml && !hasXml) {
    logSink('warn', `[WechatDraft] no local PDF/HTML/XML full text for PMID ${input.pmid}, using template fallback`);
    return false;
  }

  // Regeneration must start with a clean hidden conversation. Otherwise a
  // pooled PMID session may still be sitting at the previous Word-export
  // prompt and answer the new run by converting Word again without rewriting
  // the Markdown/images first.
  if (coworkRuntime) stopTaskHiddenSession(input.pmid, coworkRuntime);
  else clearTaskHiddenSession(input.pmid);
  logSink('info', `[WechatDraft] starting Markdown regeneration for PMID ${input.pmid}`);

  const assetsDirName = `wechat-${input.pmid}-assets`;
  const assetsDir = path.join(path.dirname(localPath), assetsDirName);
  // A regeneration must not reuse figures from a previous run. The paths are
  // derived from the current PMID and are limited to the pipeline artifact dir.
  await fs.rm(localPath, { force: true });
  await fs.rm(assetsDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });

  try {
    const result = await runTaskHiddenSession(
      input.pmid,
      {
        prompt: buildGenerationPrompt({
          pmid: input.pmid,
          authors: input.authors,
          categoryIds: input.categoryIds,
          pdfPath: hasPdf ? pdfPath : null,
          htmlPath: hasHtml ? htmlPath : null,
          xmlPath: hasXml ? xmlPath : null,
          assetsDir,
          assetsDirName,
          localPath,
        }),
        agentId: agentId ?? 'main',
        modelOverride,
        // Article writing + PDF figure extraction is the heaviest hidden
        // session in the pipeline — take the module's full 5-minute cap.
      },
      { runtime: coworkRuntime, store: coworkStore, resolveAgentCwd, log },
    );
    if (!result.finalText.includes('DONE')) {
      logSink('warn', `[WechatDraft] agent did not report DONE for PMID ${input.pmid}: ${result.finalText.slice(0, 200)}`);
      return false;
    }
    const generated = await fs.readFile(localPath, 'utf-8').catch(() => '');
    if (generated.length < MIN_GENERATED_MARKDOWN_CHARS) {
      logSink('warn', `[WechatDraft] generated draft too short (${generated.length} chars) for PMID ${input.pmid}, using template fallback`);
      return false;
    }
    logSink('info', `[WechatDraft] agent generated ${generated.length} chars for PMID ${input.pmid}`);
    return true;
  } catch (err) {
    logSink('warn', `[WechatDraft] hidden session failed for PMID ${input.pmid}: ${err instanceof Error ? err.message : 'unknown'}`);
    return false;
  }
}

function buildTitle(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
}): string {
  const firstAuthor = input.authors[0]?.fullName ?? 'Unknown';
  return `[LobsterAI] PMID ${input.pmid} — ${firstAuthor} 等`;
}

function renderMarkdown(input: {
  pmid: string;
  title: string;
  summary: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  categoryIds: string[];
  tagIds: string[];
  pdfUrl: string | null;
}): string {
  const authorList = input.authors.map(a => a.fullName).join(', ');
  const categoryList = input.categoryIds.length
    ? input.categoryIds.map(c => `\`${c}\``).join(' ')
    : '_(待分配)_';
  const tagList = input.tagIds.length ? input.tagIds.map(t => `#${t}`).join(' ') : '';

  return [
    `# ${input.title}`,
    '',
    `> PMID: \`${input.pmid}\``,
    `> Authors: ${authorList || '_未知_'}`,
    `> Categories: ${categoryList}`,
    tagList ? `> Tags: ${tagList}` : '',
    '',
    '## 摘要',
    '',
    input.summary,
    '',
    // `pdfUrl` holds the primary full-text artifact's OSS key — a real PDF
    // (`pdf/{pmid}.pdf`) or, on the closed-access path, the HTML landing
    // page (`html/{pmid}.html`). The label must not claim "下载 PDF" for
    // an HTML artifact.
    input.pdfUrl ? `## 全文\n\n[查看全文](${input.pdfUrl})\n` : '',
    '---',
    '',
    '_本 Markdown 由 LobsterAI 自动生成，请人工编辑后发布到公众号并把 docUrl 粘贴回 LobsterAI。_',
  ]
    .filter(line => line !== null && line !== undefined)
    .join('\n');
}
