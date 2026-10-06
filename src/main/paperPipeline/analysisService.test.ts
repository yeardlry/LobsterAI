import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';

/**
 * `generateAnalysis` drives the pooled hidden session via
 * `runTaskHiddenSession` on its LLM path. We mock just that function (the
 * real `resolveTaskSessionDeps` stays — it only checks that the session
 * trio is wired) so the fallback logic runs against controlled replies.
 */
const runTaskHiddenSessionMock = vi.fn();

vi.mock('./taskHiddenSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskHiddenSession')>();
  return {
    ...actual,
    runTaskHiddenSession: (...args: unknown[]) => runTaskHiddenSessionMock(...args),
  };
});

// Import after vi.mock so the mock is wired up before module init.
const { generateAnalysis } = await import('./analysisService');

const SAMPLE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <Article>
        <ArticleTitle>LNP delivery of mRNA vaccines</ArticleTitle>
        <Abstract>
          <AbstractText>This paper describes a novel lipid nanoparticle system for mRNA delivery.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><ForeName>Alice</ForeName><LastName>Reiser</LastName></Author>
          <Author><ForeName>Bob</ForeName><LastName>Woschée</LastName></Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

/** Session deps wired with dummies — the runner is mocked, so only
 * truthiness matters (mirrors what `resolveTaskSessionDeps` checks). */
const wiredDeps = {
  coworkRuntime: {} as CoworkRuntime,
  coworkStore: {} as CoworkStore,
  resolveAgentCwd: () => '/tmp',
};

describe('analysisService (heuristic fallback)', () => {
  afterEach(() => {
    runTaskHiddenSessionMock.mockReset();
  });

  test('returns a structured summary that includes the title and authors', async () => {
    const summary = await generateAnalysis({
      pmid: '39106599',
      xml: SAMPLE_XML,
      authors: [],
    });
    expect(summary).toContain('LNP delivery of mRNA vaccines');
    expect(summary).toContain('Alice Reiser');
    expect(summary).toContain('PMID 39106599');
    expect(summary).toContain('启发式模板');
    // No session deps wired → no LLM attempt at all.
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
  });

  test('falls back to author list when XML is empty', async () => {
    const summary = await generateAnalysis({
      pmid: '42',
      xml: '',
      authors: [
        { fullName: 'Alice Reiser', firstName: 'Alice', lastName: 'Reiser' },
      ],
    });
    expect(summary).toContain('Alice Reiser');
    expect(summary).toContain('摘要原文缺失');
  });

  test('truncates very long abstracts', async () => {
    const longAbstract = 'A'.repeat(2000);
    const xml = `<?xml version="1.0"?><Abstract><AbstractText>${longAbstract}</AbstractText></Abstract>`;
    const summary = await generateAnalysis({
      pmid: '99',
      xml,
      authors: [],
    });
    expect(summary.length).toBeLessThan(2000);
    expect(summary).toContain('…');
  });

  test('skips the LLM path when the cached XML file is missing', async () => {
    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath: path.join(os.tmpdir(), 'definitely-missing-77.xml'),
      deps: wiredDeps,
    });
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
    expect(summary).toContain('启发式模板');
  });
});

describe('analysisService (LLM path)', () => {
  let tmpDir: string;
  let xmlPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'analysis-'));
    xmlPath = path.join(tmpDir, '77.xml');
    await fsp.writeFile(xmlPath, SAMPLE_XML, 'utf8');
  });

  afterEach(() => {
    runTaskHiddenSessionMock.mockReset();
  });

  test('returns the agent-written summary when it is plausible', async () => {
    const llmSummary = `【标题】 LNP 递送 mRNA 疫苗\n【作者】 Alice Reiser 等 1 人\n【研究背景】 ${'脂质纳米颗粒递送系统是 mRNA 疫苗的核心。'.repeat(3)}`;
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: llmSummary,
      segmentCount: 1,
    });

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath,
      deps: wiredDeps,
    });

    expect(summary).toBe(llmSummary);
    expect(runTaskHiddenSessionMock).toHaveBeenCalledTimes(1);
    const [pmid, input] = runTaskHiddenSessionMock.mock.calls[0] as unknown as [
      string,
      { prompt: string; agentId: string },
    ];
    expect(pmid).toBe('77');
    expect(input.prompt).toContain(xmlPath);
    expect(input.prompt).toContain('PMID：77');
    expect(input.agentId).toBe('main');
  });

  test('falls back to the heuristic when the agent reports FAILED', async () => {
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'FAILED: cannot read the XML file',
      segmentCount: 1,
    });

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath,
      deps: wiredDeps,
    });

    expect(summary).toContain('启发式模板');
  });

  test('falls back to the heuristic when the reply is too short', async () => {
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: '太短了',
      segmentCount: 1,
    });

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath,
      deps: wiredDeps,
    });

    expect(summary).toContain('启发式模板');
  });

  test('falls back to the heuristic when the session throws', async () => {
    runTaskHiddenSessionMock.mockRejectedValue(new Error('timed out'));

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath,
      deps: wiredDeps,
    });

    expect(summary).toContain('启发式模板');
  });
});

describe('analysisService (full-text markdown input)', () => {
  let tmpDir: string;
  let xmlPath: string;
  let fulltextMdPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'analysis-md-'));
    xmlPath = path.join(tmpDir, '77.xml');
    fulltextMdPath = path.join(tmpDir, '77.md');
    await fsp.writeFile(xmlPath, SAMPLE_XML, 'utf8');
    await fsp.writeFile(
      fulltextMdPath,
      `# LNP delivery of mRNA vaccines\n\n${'结果部分的正文段落，包含样本量与 p 值。'.repeat(50)}`,
      'utf8',
    );
  });

  afterEach(() => {
    runTaskHiddenSessionMock.mockReset();
  });

  test('prefers the full-text markdown in the prompt when provided', async () => {
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: `【标题】 LNP 递送 mRNA 疫苗\n【关键发现】 ${'正文数据。'.repeat(20)}`,
      segmentCount: 1,
    });

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      xmlPath,
      fulltextMdPath,
      deps: wiredDeps,
    });

    expect(summary).toContain('【关键发现】');
    const [, input] = runTaskHiddenSessionMock.mock.calls[0] as unknown as [
      string,
      { prompt: string },
    ];
    // The md is the primary source; the XML demotes to a supplement.
    expect(input.prompt).toContain(
      `全文 Markdown（来源：HTML 公开落地页，本地文件，UTF-8）：${fulltextMdPath} —— 优先阅读`,
    );
    expect(input.prompt).toContain(
      `全文 XML（本地文件，UTF-8，题录与结构化摘要）：${xmlPath} —— 作为补充`,
    );
    expect(input.prompt).toContain('若 HTML 只有摘要，不能补写正文数据');
  });

  test('runs the LLM path with only a full-text markdown (no cached XML file)', async () => {
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: `【标题】 LNP 递送 mRNA 疫苗\n【关键发现】 ${'正文数据。'.repeat(20)}`,
      segmentCount: 1,
    });

    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      fulltextMdPath,
      deps: wiredDeps,
    });

    expect(summary).toContain('【关键发现】');
    const [, input] = runTaskHiddenSessionMock.mock.calls[0] as unknown as [
      string,
      { prompt: string },
    ];
    expect(input.prompt).toContain(fulltextMdPath);
    expect(input.prompt).not.toContain('全文 XML');
  });

  test('falls back to the heuristic when the md file is missing and there is no xmlPath', async () => {
    const summary = await generateAnalysis({
      pmid: '77',
      xml: SAMPLE_XML,
      authors: [],
      fulltextMdPath: path.join(tmpDir, 'missing.md'),
      deps: wiredDeps,
    });

    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
    expect(summary).toContain('启发式模板');
  });
});
