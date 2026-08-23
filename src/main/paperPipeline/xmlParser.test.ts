import { describe, expect, test } from 'vitest';

import {
  extractAbstract,
  extractTitle,
  parseAuthors,
} from './xmlParser';

const SAMPLE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>39106599</PMID>
      <Article>
        <ArticleTitle>LNP delivery of mRNA vaccines</ArticleTitle>
        <Abstract>
          <AbstractText Label="Background">Background content.</AbstractText>
          <AbstractText Label="Methods">Methods content.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author>
            <ForeName>Alice</ForeName>
            <LastName>Reiser</LastName>
            <Affiliation>Bio Inc.</Affiliation>
          </Author>
          <Author>
            <ForeName>Bob</ForeName>
            <LastName>Woschée</LastName>
          </Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

describe('xmlParser', () => {
  test('parseAuthors extracts ForeName + LastName + order', () => {
    const authors = parseAuthors(SAMPLE_XML);
    expect(authors).toHaveLength(2);
    expect(authors[0]?.fullName).toBe('Alice Reiser');
    expect(authors[0]?.firstName).toBe('Alice');
    expect(authors[0]?.lastName).toBe('Reiser');
    expect(authors[0]?.affiliation).toBe('Bio Inc.');
    expect(authors[0]?.order).toBe(1);
    expect(authors[1]?.fullName).toBe('Bob Woschée');
    expect(authors[1]?.order).toBe(2);
  });

  test('parseAuthors returns [] for empty input', () => {
    expect(parseAuthors('')).toEqual([]);
    expect(parseAuthors('not xml')).toEqual([]);
  });

  test('parseAuthors dedupes same names with different casing', () => {
    const dupXml = `<?xml version="1.0"?>
      <AuthorList>
        <Author><ForeName>Alice</ForeName><LastName>Reiser</LastName></Author>
        <Author><ForeName>ALICE</ForeName><LastName>REISER</LastName></Author>
      </AuthorList>`;
    expect(parseAuthors(dupXml)).toHaveLength(1);
  });

  test('parseAuthors falls back to text scan when XML is non-PubMed', () => {
    const authors = parseAuthors('<AuthorList><Author><Name>Collective Group</Name></Author></AuthorList>');
    expect(authors).toHaveLength(1);
    expect(authors[0]?.fullName).toBe('Collective Group');
  });

  test('extractTitle pulls ArticleTitle', () => {
    expect(extractTitle(SAMPLE_XML)).toBe('LNP delivery of mRNA vaccines');
  });

  test('extractAbstract concatenates AbstractText sections', () => {
    const abstract = extractAbstract(SAMPLE_XML);
    expect(abstract).toContain('Background content.');
    expect(abstract).toContain('Methods content.');
  });
});