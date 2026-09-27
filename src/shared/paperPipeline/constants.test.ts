import { describe, expect, test } from 'vitest';

import { buildLitArchiveKey, LitArchiveFileType } from './constants';

/**
 * Archive-key contract (2026-09-16, lit backend `LitUploadController` +
 * `LiteratureExternalServiceImpl#submitFile`): pmid-keyed uploads land at
 * `{fileType}/{pmid}.{ext}` and `submitFile` rejects any other url. These
 * tests pin the client side of that contract so a layout change here is a
 * conscious act, not drift.
 */
describe('buildLitArchiveKey', () => {
  test('builds the pdf archive key the backend validates against', () => {
    expect(buildLitArchiveKey(LitArchiveFileType.Pdf, '39106599')).toBe('pdf/39106599.pdf');
  });

  test('maps every archive type to its dir and canonical extension', () => {
    expect(buildLitArchiveKey(LitArchiveFileType.Html, '1')).toBe('html/1.html');
    expect(buildLitArchiveKey(LitArchiveFileType.Word, '1')).toBe('word/1.docx');
    expect(buildLitArchiveKey(LitArchiveFileType.Xml, '1')).toBe('xml/1.xml');
    expect(buildLitArchiveKey(LitArchiveFileType.Md, '1')).toBe('md/1.md');
  });

  test('returns null for non-archive file types', () => {
    expect(buildLitArchiveKey('image', '1')).toBeNull();
    expect(buildLitArchiveKey('', '1')).toBeNull();
  });
});
