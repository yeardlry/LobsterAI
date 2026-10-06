import { describe, expect, test } from 'vitest';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import { buildGenerationPrompt } from './wechatGenerationPrompt';

/**
 * Full-text source priority for the WeChat draft prompt (2026-09-19,
 * user requirement): PDF full text > closed-access HTML landing page >
 * PubMed XML (title/abstract only). Pure string assertions — the module
 * is Electron-free on purpose (same rationale as wechatDraftMeta.ts).
 */
const AUTHORS: PaperTaskAuthor[] = [
  { fullName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
];

const BASE_INPUT = {
  pmid: '38342193',
  authors: AUTHORS,
  categoryIds: ['cat-1'],
  assetsDir: '/tmp/wechat-38342193-assets',
  assetsDirName: 'wechat-38342193-assets',
  localPath: '/tmp/wechat-38342193.md',
};

describe('buildGenerationPrompt source priority', () => {
  test('pdf + xml: PDF numbered 1, XML numbered 2, no HTML line (regression)', () => {
    const prompt = buildGenerationPrompt({
      ...BASE_INPUT,
      pdfPath: '/tmp/paperPipeline/pdfs/38342193.pdf',
      htmlPath: null,
      xmlPath: '/tmp/paperPipeline/xml/38342193.xml',
    });

    expect(prompt).toContain('1. 本地 PDF 全文（优先）：/tmp/paperPipeline/pdfs/38342193.pdf');
    expect(prompt).toContain('2. 全文 XML（PDF/HTML 均不可用时使用）：/tmp/paperPipeline/xml/38342193.xml');
    expect(prompt).not.toContain('本地 HTML 页面');
    // Figures are available: keep the extraction requirement.
    expect(prompt).toContain('只从目标 PDF 中挑选 2-4 张实际存在');
  });

  test('html + xml: HTML numbered 1 with landing-page wording, XML numbered 2', () => {
    const prompt = buildGenerationPrompt({
      ...BASE_INPUT,
      pdfPath: null,
      htmlPath: '/tmp/paperPipeline/html/38342193.html',
      xmlPath: '/tmp/paperPipeline/xml/38342193.xml',
    });

    expect(prompt).toContain(
      '1. 本地 HTML 页面（PDF 不可用时使用）：/tmp/paperPipeline/html/38342193.html',
    );
    expect(prompt).toContain('文献公开落地页（PubMed/EuropePMC）');
    expect(prompt).toContain('严禁据此编造数据或图片');
    expect(prompt).toContain('2. 全文 XML（PDF/HTML 均不可用时使用）：/tmp/paperPipeline/xml/38342193.xml');
    expect(prompt).not.toContain('本地 PDF 全文');
    // No PDF → no figure extraction; the agent must skip figures instead
    // of inventing links for a landing page.
    expect(prompt).toContain('图表通常不可得');
    expect(prompt).not.toContain('从 PDF 中挑选');
  });

  test('all three sources: ordering PDF(1) / HTML(2) / XML(3)', () => {
    const prompt = buildGenerationPrompt({
      ...BASE_INPUT,
      pdfPath: '/tmp/paperPipeline/pdfs/38342193.pdf',
      htmlPath: '/tmp/paperPipeline/html/38342193.html',
      xmlPath: '/tmp/paperPipeline/xml/38342193.xml',
    });

    expect(prompt).toContain('1. 本地 PDF 全文（优先）：/tmp/paperPipeline/pdfs/38342193.pdf');
    expect(prompt).toContain('2. 本地 HTML 页面（PDF 不可用时使用）：/tmp/paperPipeline/html/38342193.html');
    expect(prompt).toContain('3. 全文 XML（PDF/HTML 均不可用时使用）：/tmp/paperPipeline/xml/38342193.xml');
  });

  test('xml only: XML numbered 1, figure clause skipped', () => {
    const prompt = buildGenerationPrompt({
      ...BASE_INPUT,
      pdfPath: null,
      htmlPath: null,
      xmlPath: '/tmp/paperPipeline/xml/38342193.xml',
    });

    expect(prompt).toContain('1. 全文 XML（PDF/HTML 均不可用时使用）：/tmp/paperPipeline/xml/38342193.xml');
    expect(prompt).toContain('图表通常不可得');
  });
});
