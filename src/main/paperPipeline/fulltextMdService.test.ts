import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';

/**
 * `convertFulltextToMarkdown` drives the pooled hidden session via
 * `runTaskHiddenSession`. We mock just that function (the real
 * `resolveTaskSessionDeps` stays — it only checks that the session trio is
 * wired), and mock `./storage` so the md path points into a per-test tmp
 * dir without touching `electron`.
 */
const runTaskHiddenSessionMock = vi.fn();

vi.mock('./taskHiddenSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskHiddenSession')>();
  return {
    ...actual,
    runTaskHiddenSession: (...args: unknown[]) => runTaskHiddenSessionMock(...args),
  };
});

const getFulltextMdPathMock = vi.fn();
vi.mock('./storage', () => ({
  getPaperPipelineFulltextMdPath: (...args: unknown[]) => getFulltextMdPathMock(...args),
}));

// Import after vi.mock so the mocks are wired up before module init.
const {
  convertFulltextToMarkdown,
  getExistingFulltextMdPath,
} = await import('./fulltextMdService');

const PMID = '38342193';

/** Session deps wired with dummies — the runner is mocked, so only
 * truthiness matters (mirrors what `resolveTaskSessionDeps` checks). */
const wiredDeps = {
  coworkRuntime: {} as CoworkRuntime,
  coworkStore: {} as CoworkStore,
  resolveAgentCwd: () => '/tmp',
};

/** Long enough to clear the 300-char plausibility bar. */
const PLAUSIBLE_MD = `# LNP delivery of mRNA vaccines\n\n${'正文段落。'.repeat(100)}`;

describe('fulltextMdService', () => {
  let tmpDir: string;
  let mdPath: string;
  let sourcePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fulltext-md-'));
    mdPath = path.join(tmpDir, '38342193.md');
    sourcePath = path.join(tmpDir, '38342193.pdf');
    getFulltextMdPathMock.mockImplementation((pmid: string) => path.join(tmpDir, `${pmid}.md`));
    await fsp.writeFile(sourcePath, '%PDF-1.4 fake pdf', 'utf-8');
  });

  afterEach(async () => {
    runTaskHiddenSessionMock.mockReset();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns the md path when the session reports DONE and the file is plausible', async () => {
    runTaskHiddenSessionMock.mockImplementation(async () => {
      await fsp.writeFile(mdPath, PLAUSIBLE_MD, 'utf-8');
      return { sessionId: 'sess-1', finalText: 'DONE', segmentCount: 1 };
    });

    const result = await convertFulltextToMarkdown({
      pmid: PMID,
      sourcePath,
      sourceKind: 'pdf',
      deps: wiredDeps,
    });

    expect(result).toBe(mdPath);
    expect(runTaskHiddenSessionMock).toHaveBeenCalledTimes(1);
    const [pmid, input] = runTaskHiddenSessionMock.mock.calls[0] as unknown as [
      string,
      { prompt: string; agentId: string },
    ];
    expect(pmid).toBe(PMID);
    expect(input.prompt).toContain(sourcePath);
    expect(input.prompt).toContain(mdPath);
    expect(input.agentId).toBe('main');
  });

  test('reuses an existing conversion without a session turn', async () => {
    await fsp.writeFile(mdPath, PLAUSIBLE_MD, 'utf-8');

    const result = await convertFulltextToMarkdown({
      pmid: PMID,
      sourcePath,
      sourceKind: 'pdf',
      deps: wiredDeps,
    });

    expect(result).toBe(mdPath);
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
  });

  test('getExistingFulltextMdPath rejects a too-short cached file', async () => {
    await fsp.writeFile(mdPath, 'too short', 'utf-8');

    expect(await getExistingFulltextMdPath(PMID)).toBeNull();
  });

  test('skips the session when deps are not wired', async () => {
    const result = await convertFulltextToMarkdown({
      pmid: PMID,
      sourcePath,
      sourceKind: 'pdf',
    });

    expect(result).toBeNull();
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
  });

  test('returns null when the source file is missing', async () => {
    const result = await convertFulltextToMarkdown({
      pmid: PMID,
      sourcePath: path.join(tmpDir, 'missing.pdf'),
      sourceKind: 'pdf',
      deps: wiredDeps,
    });

    expect(result).toBeNull();
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
  });

  test('returns null when the session reports FAILED', async () => {
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'FAILED: cannot parse the PDF',
      segmentCount: 1,
    });

    expect(
      await convertFulltextToMarkdown({
        pmid: PMID,
        sourcePath,
        sourceKind: 'pdf',
        deps: wiredDeps,
      }),
    ).toBeNull();
  });

  test('returns null when the session claims DONE but the file is too short', async () => {
    runTaskHiddenSessionMock.mockImplementation(async () => {
      await fsp.writeFile(mdPath, '# stub\n\ntiny', 'utf-8');
      return { sessionId: 'sess-1', finalText: 'DONE', segmentCount: 1 };
    });

    expect(
      await convertFulltextToMarkdown({
        pmid: PMID,
        sourcePath,
        sourceKind: 'pdf',
        deps: wiredDeps,
      }),
    ).toBeNull();
  });

  test('still accepts the file when the session throws after the file landed (timeout)', async () => {
    runTaskHiddenSessionMock.mockImplementation(async () => {
      await fsp.writeFile(mdPath, PLAUSIBLE_MD, 'utf-8');
      throw new Error('hidden session timed out');
    });

    const result = await convertFulltextToMarkdown({
      pmid: PMID,
      sourcePath,
      sourceKind: 'pdf',
      deps: wiredDeps,
    });

    expect(result).toBe(mdPath);
  });

  test('returns null when the session throws and nothing landed', async () => {
    runTaskHiddenSessionMock.mockRejectedValue(new Error('hidden session timed out'));

    expect(
      await convertFulltextToMarkdown({
        pmid: PMID,
        sourcePath,
        sourceKind: 'html',
        deps: wiredDeps,
      }),
    ).toBeNull();
  });

  test('never throws — an fs failure inside the session path is swallowed', async () => {
    // Path helper explodes (e.g. userData gone): the caller must still get
    // null instead of an exception breaking the auto-advance run.
    getFulltextMdPathMock.mockImplementation(() => {
      throw new Error('storage exploded');
    });

    expect(
      await convertFulltextToMarkdown({
        pmid: PMID,
        sourcePath,
        sourceKind: 'pdf',
        deps: wiredDeps,
      }),
    ).toBeNull();
  });
});
