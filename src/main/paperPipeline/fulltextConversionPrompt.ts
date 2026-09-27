/**
 * Builder for the hidden-session prompt that converts a local full-text
 * file (downloaded PDF or closed-access HTML landing page) into a plain
 * Markdown transcription.
 *
 * Extracted as a pure module (same rationale as
 * `wechatGenerationPrompt.ts`): the service module imports Electron-only
 * dependencies, so the prompt construction lives here where tests can
 * import it without mocking `electron`.
 *
 * The output is an analysis INPUT, not a user-facing artifact: the analysis
 * step reads it to ground 【关键发现】 in body-level data (sample sizes,
 * effect sizes, p values) that the PubMed XML's abstract does not carry.
 */
export type FulltextSourceKind = 'pdf' | 'html';

export function buildFulltextConversionPrompt(input: {
  pmid: string;
  /** Absolute path of the local PDF or HTML landing page to convert. */
  sourcePath: string;
  sourceKind: FulltextSourceKind;
  /** Absolute path the Markdown must be written to (UTF-8, overwrite). */
  mdPath: string;
  title?: string | null;
}): string {
  const sourceDescription =
    input.sourceKind === 'pdf'
      ? `1. 源文件（本地 PDF 全文）：${input.sourcePath}`
      : `1. 源文件（本地 HTML 页面，可能是文献公开落地页，正文不全）：${input.sourcePath}`;

  return [
    '请把一篇生物医学文献的本地全文文件转换成 Markdown 纯文本，并保存到指定的绝对路径。',
    '',
    `文献信息：PMID ${input.pmid}`,
    input.title ? `标题：${input.title}` : '',
    sourceDescription,
    `2. 输出路径（UTF-8 编码，覆盖已有文件）：${input.mdPath}`,
    '',
    '要求：',
    `1. 动手前先检查输出路径 ${input.mdPath} 是否已有转换结果（之前的尝试可能已完成），有就直接回复一行 DONE；`,
    '2. 只允许用 CLI 工具完成转换（pdftotext、python（pdfplumber、BeautifulSoup 等）、pandoc，必要时可先安装）；全程禁止打开浏览器或任何图形界面工具；',
    '3. 尽量完整地提取正文：一级标题用文章标题，保留原有章节层级（摘要/引言/方法/结果/讨论等），逐段转换，不要总结、缩写、翻译或改写；',
    '4. 图表只保留文字说明（如「图1 ×××」），不要编造图片或外部链接；表格转成 Markdown 表格；公式转成可读的行内文本；',
    '5. 源文件是文献落地页、正文不全时，如实转换已有内容（摘要、题录），不要编造缺失的正文；',
    '6. 完成后只回复一行 DONE；源文件读不了或转换失败时回复一行 FAILED: 原因。不要把正文直接回复在对话里。',
  ]
    .filter(Boolean)
    .join('\n');
}
