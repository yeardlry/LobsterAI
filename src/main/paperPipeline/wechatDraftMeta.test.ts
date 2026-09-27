import { describe, expect, test } from 'vitest';

import { extractDraftMeta } from './wechatDraftMeta';

/**
 * The modal shows `renderedTitle` / `renderedSummary` parsed out of the
 * agent-generated Markdown. These tests pin the extraction rules so a
 * prompt change that shifts the draft shape is caught here rather than in
 * a blank modal.
 */
describe('extractDraftMeta', () => {
  test('takes the first heading as title and the first body paragraph as summary', () => {
    const meta = extractDraftMeta([
      '# mRNA 疫苗的快递小哥',
      '',
      '脂质纳米颗粒（LNP）像一辆快递车，把 mRNA 送到免疫细胞门口。',
      '这是导语的第二句，长度凑够。',
      '',
      '## 第一节',
      '',
      '正文从这里开始。',
    ].join('\n'));
    expect(meta.title).toBe('mRNA 疫苗的快递小哥');
    // Soft-wrapped lines join with a space (correct for English; harmless
    // for Chinese display text in the modal).
    expect(meta.summary).toBe('脂质纳米颗粒（LNP）像一辆快递车，把 mRNA 送到免疫细胞门口。 这是导语的第二句，长度凑够。');
  });

  test('skips blockquotes and images before the first body paragraph', () => {
    const meta = extractDraftMeta([
      '# 标题',
      '',
      '> 引言块引用',
      '',
      '![图1](wechat-1-assets/fig1.png)',
      '',
      '真正的导语段落，出现在图片之后。',
      '再补一句凑长度。',
    ].join('\n'));
    expect(meta.summary).toBe('真正的导语段落，出现在图片之后。 再补一句凑长度。');
  });

  test('truncates a long summary and returns nulls for empty input', () => {
    const long = '很长的导语。'.repeat(100);
    const meta = extractDraftMeta(`# 标题\n\n${long}`);
    expect(meta.summary?.length).toBe(301);
    expect(meta.summary?.endsWith('…')).toBe(true);

    expect(extractDraftMeta('')).toEqual({ title: null, summary: null });
    expect(extractDraftMeta('没有标题的裸文本')).toEqual({ title: null, summary: null });
  });
});
