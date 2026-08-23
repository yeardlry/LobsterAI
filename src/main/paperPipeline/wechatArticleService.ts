import { promises as fs } from 'node:fs';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import {
  ensurePaperPipelineDirs,
  getPaperPipelineArtifactPath,
} from './storage';

/**
 * WeChat article generator (manual paste workflow).
 *
 * We do NOT call the WeChat Open API from LobsterAI — LobsterAI has no
 * access to the user's WeChat 公众号 credentials. Instead we:
 *
 *   1. Render the literature into a publication-ready Markdown article
 *      (title / authors / extSummary / categories / tags / PDF link) on the
 *      local disk under `app.getPath('userData')/paperPipeline/wechat/<pmid>.md`.
 *   2. Upload that Markdown to the lit backend via `POST /lit/upload/oss`
 *      so the article is reachable from any 微信编辑器 web tab (the URL
 *      is the only thing we put into `extras.markdownUrl` for traceability).
 *   3. The renderer pops a modal that previews the Markdown and asks the
 *      user to copy the content into the 微信公众平台 编辑器 themselves,
 *      then paste the resulting `https://mp.weixin.qq.com/s/...` docUrl
 *      back into the same modal. Only then does the UI call
 *      `submitWechatDoc(pmid, docUrl, extras)` to push the task to
 *      `completed`.
 *
 * The signature is the contract Phase 4 must keep:
 *   prepareWechatDraft(input): Promise<{
 *     localMarkdownPath: string;       // for the in-app preview
 *     markdownUrl: string;             // public OSS URL we put into extras
 *     renderedTitle: string;           // pre-filled title in the modal
 *     renderedSummary: string;         // pre-filled summary in the modal
 *   }>
 *
 * Phase 4 work (replaces stub body):
 *   - call OpenClaw with a hidden Cowork session + work / image-analysis /
 *     literature-format skills to get a richer draft (replaces the local
 *     `renderMarkdown` template below);
 *   - save the rendered Markdown to disk and `uploadFile` via
 *     `/lit/upload/oss`;
 *   - return the file path + OSS URL so the renderer can offer both a
 *     "Copy Markdown" button and a "Open in browser" button.
 */
export interface WechatDraft {
  localMarkdownPath: string;
  markdownUrl: string;
  renderedTitle: string;
  renderedSummary: string;
}

export async function prepareWechatDraft(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  categoryIds: string[];
  tagIds: string[];
  pdfUrl: string | null;
}): Promise<WechatDraft> {
  const title = buildTitle(input);
  const summary = input.extSummary || '(暂无 extSummary，请人工补一段导语)';
  const markdown = renderMarkdown({ title, summary, ...input });
  const filename = `wechat-${input.pmid}.md`;
  await ensurePaperPipelineDirs();
  const localPath = getPaperPipelineArtifactPath('wechat', filename);
  await fs.writeFile(localPath, markdown, 'utf8');

  // Phase 4: replace with a real `uploadFile({ localPath, fileType: 'html' })`
  // call against `POST /lit/upload/oss`. For the stub we hand back a local
  // file:// URL so the UI "Open in browser" button at least opens something
  // sensible during integration testing.
  const markdownUrl = `file://${localPath}`;

  return {
    localMarkdownPath: localPath,
    markdownUrl,
    renderedTitle: title,
    renderedSummary: summary,
  };
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
    input.pdfUrl ? `## 全文 PDF\n\n[下载 PDF](${input.pdfUrl})\n` : '',
    '---',
    '',
    '_本 Markdown 由 LobsterAI 自动生成，请人工编辑后发布到公众号并把 docUrl 粘贴回 LobsterAI。_',
  ]
    .filter(line => line !== null && line !== undefined)
    .join('\n');
}