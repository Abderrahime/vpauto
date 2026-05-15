// Regression test pinning the parser output against real Tesseract OCR
// captures of seven distinct CT PV layouts the user shared during
// development. Each fixture file is the verbatim OCR text returned by
// `tesseract <jpeg> - -l fra --psm 4` on the PDF at
// `https://cdn.vpauto.fr/d/<id>_CT.pdf`. Re-running them on fresh OCR
// would shift a few characters here and there (Tesseract output isn't
// strictly deterministic across builds), so we freeze the input.
//
// Adding a new fixture: drop the OCR text into
// `__fixtures__/ct-ocr/<id>.txt`, add an entry to the table below.
//
// Updating an expected label: change the table here. The parser logic
// lives in `ctParser.ts`; if you tighten/loosen it, expect to update
// a few rows.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCtPdfSummary } from '../ctParser';

const here = dirname(fileURLToPath(import.meta.url));
const loadOcrFixture = (id: string) =>
  readFileSync(join(here, 'ct-ocr', `${id}.txt`), 'utf8');

type FixtureExpectation = {
  id: string;
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'unknown';
  /** Human note — what the user said this PDF actually is. */
  intent: string;
  /** Optional defect-code expectations. */
  majorCodes?: string[];
  minorCodes?: string[];
};

const FIXTURES: FixtureExpectation[] = [
  {
    id: 'AZitKsP',
    intent: 'SNCTA voluntary CT — peugeot 208 with no defects (CT OK)',
    label: 'CT volontaire OK (vide)',
    tone: 'ok',
    majorCodes: [],
    minorCodes: [],
  },
  {
    id: 'uDwVwFR',
    intent: 'Vivauto voluntary CT — no defects (CT OK)',
    label: 'CT volontaire OK (vide)',
    tone: 'ok',
    majorCodes: [],
    minorCodes: [],
  },
  {
    id: 'YBdxKOH',
    intent: 'DEKRA voluntary CT — multiple major defects (and 2 minors)',
    label: 'CT volontaire · 7 défauts majeurs',
    tone: 'bad',
    // Majors fall under the "défaillances constatées (ne permettant pas…)"
    // heading; minors land under "Autres défaillances constatées".
    majorCodes: ['4.1.1.2', '4.2.1.2', '4.3.1', '4.5.1.b.2', '45.1.2.2', '4.8.1', '6.2.6.2'],
    minorCodes: ['4.5.2.2', '5.2.3.i.1'],
  },
  {
    id: 'TYECfWB',
    intent: 'Auto Sécurité voluntary CT — measurement-only PV, no defects',
    label: 'CT volontaire OK',
    tone: 'ok',
    majorCodes: [],
    minorCodes: [],
  },
  {
    id: 'EHFjMRK',
    intent: 'Securitest voluntary CT — column header "DÉFAILLANCES CONSTATÉES" but empty section',
    label: 'CT volontaire OK (vide)',
    tone: 'ok',
    majorCodes: [],
    minorCodes: [],
  },
  {
    id: 'Mcidvpj',
    intent: 'Securitest voluntary CT — sibling of EHFjMRK, same shape',
    label: 'CT volontaire OK (vide)',
    tone: 'ok',
    majorCodes: [],
    minorCodes: [],
  },
  {
    id: 'yGXlPqv',
    intent: 'Autosur regulatory CT — "Favorable" verdict + 3 minor defect codes (codes use commas)',
    label: 'CT · 3 défauts mineurs',
    tone: 'warn',
    majorCodes: [],
    // Tesseract reads the section-numbers' dots as commas; the parser
    // normalises both back to dots in `extractCtDefectCodes`.
    minorCodes: ['4.5.2.a.1', '5.3.3.a.1', '7.1.2.b.1'],
  },
];

describe('parseCtPdfSummary — real-world OCR regression fixtures', () => {
  for (const expectation of FIXTURES) {
    it(`${expectation.id} — ${expectation.intent}`, () => {
      const text = loadOcrFixture(expectation.id);
      const { summary, diagnostics } = parseCtPdfSummary(text);

      expect(summary?.label, `${expectation.id} label`).toBe(expectation.label);
      expect(summary?.tone, `${expectation.id} tone`).toBe(expectation.tone);

      if (expectation.majorCodes !== undefined) {
        expect(diagnostics.majorCodes, `${expectation.id} majorCodes`).toEqual(expectation.majorCodes);
      }
      if (expectation.minorCodes !== undefined) {
        expect(diagnostics.minorCodes, `${expectation.id} minorCodes`).toEqual(expectation.minorCodes);
      }
    });
  }
});
