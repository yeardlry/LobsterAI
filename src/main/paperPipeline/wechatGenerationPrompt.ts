import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';

/**
 * Builder for the hidden-session prompt that writes the WeChat Markdown
 * draft.
 *
 * Extracted from `wechatArticleService.ts` (same rationale as
 * `wechatDraftMeta.ts`): the service module imports Electron-only
 * dependencies, so the pure prompt construction lives here where tests can
 * import it without mocking `electron`.
 *
 * Full-text source priority (2026-09-19, user requirement): the downloaded
 * PDF first, then the closed-access HTML landing page (`html/{pmid}.html`),
 * and only when neither exists the cached PubMed XML — which carries just
 * title/abstract/authors, no full text.
 */
export function buildGenerationPrompt(input: {
  pmid: string;
  authors: PaperTaskAuthor[];
  categoryIds: string[];
  pdfPath: string | null;
  htmlPath: string | null;
  xmlPath: string | null;
  assetsDir: string;
  assetsDirName: string;
  localPath: string;
}): string {
  const authorList = input.authors.map(a => a.fullName).join(', ');
  const sources: string[] = [];
  if (input.pdfPath) {
    sources.push(`1. 本地 PDF 全文（优先）：${input.pdfPath} —— 用 pdftotext、python 等工具提取正文文本和插图`);
  }
  if (input.htmlPath) {
    sources.push(`${input.pdfPath ? '2' : '1'}. 本地 HTML 页面（PDF 不可用时使用）：${input.htmlPath} —— 文献公开落地页（PubMed/EuropePMC），可能只有摘要和题录信息，没有完整正文与图表；严禁据此编造数据或图片`);
  }
  if (input.xmlPath) {
    const index = (input.pdfPath ? 1 : 0) + (input.htmlPath ? 1 : 0) + 1;
    sources.push(`${index}. 全文 XML（PDF/HTML 均不可用时使用）：${input.xmlPath}`);
  }

  // Figures only exist in the PDF. On the HTML/XML tiers say so up front
  // — otherwise the agent hallucinates figure links for a landing page.
  const figureRequirement = input.pdfPath
    ? `3. 图文并茂：从 PDF 中挑选 2-4 张最关键的图表（机制图、数据图），提取保存为 PNG 到目录 ${input.assetsDir}（文件名用 fig1.png、fig2.png 等英文命名），在 Markdown 中用相对路径 ${input.assetsDirName}/figN.png 引用，并给每张图配一句中文说明。无法提取图片时跳过，不要编造图片链接或用外部 URL。`
    : '3. 本次全文来源不是 PDF，图表通常不可得：跳过配图即可，不要编造图片链接或用外部 URL。';

  return [
    '请为一篇生物医学文献撰写一篇图文并茂的中文公众号科普文章，并把成品保存为 Markdown 文件。',
    '',
    `文献信息：PMID ${input.pmid}`,
    authorList ? `作者：${authorList}` : '',
    input.categoryIds.length ? `分类 ID：${input.categoryIds.join(', ')}` : '',
    '',
    '全文来源（按优先级）：',
    ...sources,
    '',
    '写作要求：',
    '1. 面向对生物医学感兴趣的大众读者：通俗易懂但科学准确，重要术语首次出现时用一句话解释。',
    '2. 结构：一个吸引人的一级标题（# 开头，不要以 [LobsterAI] 或 PMID 开头）；2-3 句导语；3-5 个二级标题小节（## 开头），每节讲清一个核心发现或机制，引用原文关键数据；结语；最后附「文献信息」小节（PMID、作者）。',
    figureRequirement,
    `4. 把文章全文以 UTF-8 编码写入这个绝对路径（覆盖已有文件）：${input.localPath}`,
    '',
    '完成后只回复一行 DONE；无法完成时回复一行 FAILED: 原因。不要把正文直接回复在对话里。',
  ]
    .filter(Boolean)
    .join('\n');
}
