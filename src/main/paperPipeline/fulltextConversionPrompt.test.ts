import { describe, expect, test } from 'vitest';

import { buildFulltextConversionPrompt } from './fulltextConversionPrompt';

/**
 * Pure string assertions for the full-text conversion prompt — the module
 * is Electron-free on purpose (same rationale as
 * `wechatGenerationPrompt.ts`). The prompt follows the pdfUrlFinder
 * file-producing pattern: absolute paths, CLI-only, one-line DONE/FAILED
 * marker, no body text in the chat reply.
 */
const BASE_INPUT = {
  pmid: '38342193',
  mdPath: '/tmp/paperPipeline/fulltext/38342193.md',
  title: 'LNP delivery of mRNA vaccines',
};

describe('buildFulltextConversionPrompt', () => {
  test('pdf source: names the PDF, the output path, and the cache check', () => {
    const prompt = buildFulltextConversionPrompt({
      ...BASE_INPUT,
      sourcePath: '/tmp/paperPipeline/pdfs/38342193.pdf',
      sourceKind: 'pdf',
    });

    expect(prompt).toContain('1. 源文件（本地 PDF 全文）：/tmp/paperPipeline/pdfs/38342193.pdf');
    expect(prompt).toContain('2. 输出路径（UTF-8 编码，覆盖已有文件）：/tmp/paperPipeline/fulltext/38342193.md');
    // The agent must check the output path first — a previous attempt may
    // already have finished (re-runs after a later-step failure are common).
    expect(prompt).toContain('动手前先检查输出路径 /tmp/paperPipeline/fulltext/38342193.md');
    expect(prompt).toContain('PMID 38342193');
    expect(prompt).toContain('标题：LNP delivery of mRNA vaccines');
  });

  test('html source: landing-page wording and the no-fabrication clause', () => {
    const prompt = buildFulltextConversionPrompt({
      ...BASE_INPUT,
      sourcePath: '/tmp/paperPipeline/html/38342193.html',
      sourceKind: 'html',
    });

    expect(prompt).toContain(
      '1. 源文件（本地 HTML 页面，可能是文献公开落地页，正文不全）：/tmp/paperPipeline/html/38342193.html',
    );
    expect(prompt).toContain('HTML 页面只能转换页面中实际存在的标题、摘要、作者和元数据');
    expect(prompt).toContain('不得把缺失的方法、结果、表格或图表补成正文');
    expect(prompt).not.toContain('本地 PDF 全文');
  });

  test('CLI-only constraint and reply markers are always present', () => {
    for (const sourceKind of ['pdf', 'html'] as const) {
      const prompt = buildFulltextConversionPrompt({
        ...BASE_INPUT,
        sourcePath: `/tmp/paperPipeline/${sourceKind}/38342193.${sourceKind}`,
        sourceKind,
      });
      expect(prompt).toContain('只允许使用当前环境已经存在的 CLI 工具');
      expect(prompt).toContain('禁止打开浏览器或任何图形界面工具');
      expect(prompt).toContain('不要总结、缩写、翻译、润色、改写');
      expect(prompt).toContain('完成后只回复一行 DONE');
      expect(prompt).toContain('FAILED: 原因');
      expect(prompt).toContain('不要把正文直接回复在对话里');
    }
  });

  test('omits the title line when no title is known', () => {
    const prompt = buildFulltextConversionPrompt({
      pmid: '38342193',
      sourcePath: '/tmp/paperPipeline/pdfs/38342193.pdf',
      sourceKind: 'pdf',
      mdPath: '/tmp/paperPipeline/fulltext/38342193.md',
      title: null,
    });

    expect(prompt).not.toContain('标题：');
    expect(prompt).toContain('PMID 38342193');
  });
});
