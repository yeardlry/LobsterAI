import { describe, expect, test } from 'vitest';

import { generateAnalysis } from './analysisService';

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

describe('analysisService (heuristic)', () => {
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
});