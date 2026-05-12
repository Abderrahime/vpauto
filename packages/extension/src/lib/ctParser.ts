// Pure-JS CT-PDF text parser. Kept separate from `badges.ts` so vitest can
// exercise it without dragging in `pdfjs-dist` (whose module init code reaches
// for `document`/`window`) and `webextension-polyfill` (which throws when
// loaded outside an extension context).

export type CtTone = 'ok' | 'warn' | 'bad' | 'unknown';

export type CtSummary = {
  label: string;
  tone: CtTone;
};

export type CtParseDiagnostics = {
  normalizedLength: number;
  sample: string;
  // Substring tells us whether the French defect vocabulary was present
  // in the extracted text at all. If `containsDefaillance` is false the
  // PDF either has no text layer (scanned) or pdfjs split the word into
  // single characters — both require different handling than the header
  // regex.
  containsDefaillance: boolean;
  containsMajeure: boolean;
  containsMineure: boolean;
  containsConstatee: boolean;
  // Index of the first "defaillance" hit in `normalized`, -1 if absent.
  // Useful to confirm we sliced at the right offset.
  defaillanceFirstIndex: number;
  defaillanceSnippet: string;
  matchedMajorHeader: boolean;
  matchedMinorHeader: boolean;
  majorCodeCount: number;
  minorCodeCount: number;
  majorCodes: string[];
  minorCodes: string[];
};

export function normalizeCtText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Some controllers insert non-breaking spaces / zero-width joiners
    // around the colon; normalise to plain spaces FIRST so the (s)
    // collapse below sees a uniform separator.
    .replace(/[   ​‌‍]/g, ' ')
    // French CT reports literally print "Défaillance(s) majeure(s)" with the
    // `(s)` parenthetical pluralisation. pdfjs sometimes returns the
    // header split across items, yielding "Defaillance (s) majeure(s)"
    // with a space before the `(s)`. Consume any preceding whitespace so
    // the `s` attaches to the previous word and produces the canonical
    // plural form expected downstream. Without `\s*`, the previous
    // version left an isolated "s" token and the major-header regex
    // (which requires `defaillances?\s+majeures?`) failed silently.
    .replace(/\s*\(s\)/g, 's')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

export function extractCtDefectCodes(section: string): string[] {
  if (!section) return [];
  // Real-world French CT defect codes observed on cdn.vpauto.fr PDFs:
  //   - 4-segment with letter: "1.2.3.a"   (most common)
  //   - 5-segment with letter: "1.2.3.a.1" (sub-detail)
  //   - 3- or 4-segment numeric only: "8.1.1" / "8.1.1.5"
  //
  // The leading `(?<![\w.])` lookbehind is critical: without it, DEKRA's
  // observation marker "Z.0.0.0.2" would falsely match starting at the
  // "0.0.0.2" tail (3 dotted digits → looks like a defect code). With
  // the lookbehind we require the leading digit to come right after a
  // non-word-non-dot character (start of string, space, comma, colon…).
  //
  // The trailing `(?![\w])` lookahead prevents matching the leading
  // "12.05.20" of a date like "12.05.2024" because the next "2" is a
  // word character.
  const codes = new Set<string>();
  const pattern = /(?<![\w.])\d{1,2}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}(?:\s*\.\s*[a-z])?(?:\s*\.\s*\d{1,2})?(?![\w])/g;
  for (const match of section.matchAll(pattern)) {
    codes.add(match[0].replace(/\s+/g, ''));
  }
  return Array.from(codes);
}

export function parseCtPdfSummary(text: string): { summary: CtSummary | null; diagnostics: CtParseDiagnostics } {
  const normalized = normalizeCtText(text);
  const defaillanceFirstIndex = normalized.indexOf('defaillance');
  const diagnostics: CtParseDiagnostics = {
    normalizedLength: normalized.length,
    sample: normalized.slice(0, 600),
    containsDefaillance: defaillanceFirstIndex !== -1,
    containsMajeure: normalized.includes('majeure'),
    containsMineure: normalized.includes('mineure'),
    containsConstatee: normalized.includes('constatee'),
    defaillanceFirstIndex,
    defaillanceSnippet: defaillanceFirstIndex === -1
      ? ''
      : normalized.slice(
          Math.max(0, defaillanceFirstIndex - 40),
          Math.min(normalized.length, defaillanceFirstIndex + 200),
        ),
    matchedMajorHeader: false,
    matchedMinorHeader: false,
    majorCodeCount: 0,
    minorCodeCount: 0,
    majorCodes: [],
    minorCodes: [],
  };
  if (!normalized) return { summary: null, diagnostics };

  // Two PDF flavours observed on cdn.vpauto.fr:
  //   (A) Regulatory CT (UTAC/SGS/Auto Sécurité…):
  //         "Défaillance(s) majeure(s)" / "Défaillance(s) mineure(s)"
  //   (B) DEKRA voluntary control:
  //         "Défaillance(s) constatée(s) (ne permettant pas la validation
  //          d'un contrôle technique réglementaire)"   ← major equivalent
  //         "Autre(s) défaillance(s) constatée(s)"      ← minor equivalent
  const majorHeaderPatterns = [
    /defaillances?\s+majeures?\s*:?/g,
    /defaillances?\s+constatees?\s+\(?\s*ne\s+permettant\s+pas/g,
  ];
  const minorHeaderPatterns = [
    /defaillances?\s+mineures?\s*:?/g,
    /autres?\s+defaillances?\s+constatees?/g,
  ];

  function findFirstHeader(patterns: RegExp[]): { match: RegExpExecArray; pattern: RegExp } | null {
    let best: { match: RegExpExecArray; pattern: RegExp } | null = null;
    for (const pat of patterns) {
      pat.lastIndex = 0;
      const m = pat.exec(normalized);
      if (m && (!best || m.index < best.match.index)) {
        best = { match: m, pattern: pat };
      }
    }
    return best;
  }

  function sliceUpToStops(headerEnd: number, stops: RegExp[]): string {
    let stopIndex = normalized.length;
    for (const stop of stops) {
      stop.lastIndex = headerEnd;
      const m = stop.exec(normalized);
      if (m && m.index < stopIndex) stopIndex = m.index;
    }
    return normalized.slice(headerEnd, stopIndex);
  }

  const universalStops = (): RegExp[] => [
    /documents?\s+presentes?/g,
    /mesures?\s+realisees?/g,
    /identite\s+du\s+controleur/g,
    /resultat\s+(?:du\s+)?controle/g,
    /prochain\s+controle/g,
    /observations?\s*:/g,
    /rappel\s*:/g,
    /z\s*\.\s*0\s*\.\s*0\s*\.\s*0/g,
  ];

  const majorHeader = findFirstHeader(majorHeaderPatterns);
  const minorHeader = findFirstHeader(minorHeaderPatterns);

  let majorContent = '';
  if (majorHeader) {
    diagnostics.matchedMajorHeader = true;
    const headerEnd = majorHeader.match.index + majorHeader.match[0].length;
    majorContent = sliceUpToStops(headerEnd, [
      ...minorHeaderPatterns.map((p) => new RegExp(p.source, p.flags)),
      ...universalStops(),
    ]);
  }

  let minorContent = '';
  if (minorHeader) {
    diagnostics.matchedMinorHeader = true;
    const headerEnd = minorHeader.match.index + minorHeader.match[0].length;
    minorContent = sliceUpToStops(headerEnd, [
      ...majorHeaderPatterns.map((p) => new RegExp(p.source, p.flags)),
      ...universalStops(),
    ]);
  }

  const isExplicitlyEmpty = (slice: string): boolean =>
    /aucune\s+defaillances?\s+constatees?/.test(slice)
    || /n[ée]ant/.test(slice.slice(0, 80));

  const majorEmpty = majorHeader && isExplicitlyEmpty(majorContent);
  const minorEmpty = minorHeader && isExplicitlyEmpty(minorContent);

  const majorCodes = majorHeader && !majorEmpty ? extractCtDefectCodes(majorContent) : [];
  const minorCodes = minorHeader && !minorEmpty ? extractCtDefectCodes(minorContent) : [];
  const majorCount = majorCodes.length;
  const minorCount = minorCodes.length;

  diagnostics.majorCodeCount = majorCount;
  diagnostics.minorCodeCount = minorCount;
  diagnostics.majorCodes = majorCodes;
  diagnostics.minorCodes = minorCodes;

  if (majorCount > 0) {
    return {
      summary: {
        label: `CT · ${majorCount} défaut${majorCount > 1 ? 's' : ''} majeur${majorCount > 1 ? 's' : ''}`,
        tone: 'bad',
      },
      diagnostics,
    };
  }

  if (minorCount > 0) {
    return {
      summary: {
        label: `CT · ${minorCount} défaut${minorCount > 1 ? 's' : ''} mineur${minorCount > 1 ? 's' : ''}`,
        tone: 'warn',
      },
      diagnostics,
    };
  }

  if ((majorEmpty || !majorHeader) && (minorEmpty || !minorHeader) && (majorHeader || minorHeader)) {
    return { summary: { label: 'CT OK', tone: 'ok' }, diagnostics };
  }

  if (majorHeader && !majorEmpty && majorContent.trim()) {
    return { summary: { label: 'CT · défauts majeurs', tone: 'bad' }, diagnostics };
  }
  if (minorHeader && !minorEmpty && minorContent.trim()) {
    return { summary: { label: 'CT · défauts mineurs', tone: 'warn' }, diagnostics };
  }

  if (/contre[-\s]?visite/.test(normalized)) {
    return { summary: { label: 'CT · contre-visite', tone: 'bad' }, diagnostics };
  }
  if (/resultat\s+favorable|controle\s+technique\s+favorable|aucune\s+defaillance/.test(normalized)) {
    return { summary: { label: 'CT OK', tone: 'ok' }, diagnostics };
  }

  // Last resort — we couldn't pin down a count, but the PDF clearly
  // belongs to the CT vocabulary (contains "défaillance" / "majeure" /
  // "mineure"). Surface that ambiguity to the user instead of letting
  // the badge fall back to the default green "CT disponible", which
  // wrongly suggests "all good" for Autovision and other formats where
  // pdfjs garbles the layout and our slice-based extraction returns 0
  // codes. The "à vérifier" wording invites the user to open the PDF.
  if (diagnostics.containsDefaillance && (diagnostics.containsMajeure || diagnostics.containsMineure)) {
    return { summary: { label: 'CT · à vérifier', tone: 'warn' }, diagnostics };
  }

  return { summary: null, diagnostics };
}
