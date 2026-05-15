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
  // Voluntary-CT vocabulary — present in DEKRA-volontaire and similar
  // reports that prefer "défauts ou anomalies" over the regulatory
  // "défaillances" wording. Tracked so the fallback can recognise these
  // PDFs as CT documents even when the header regex misses them.
  containsDefauts: boolean;
  containsAnomalies: boolean;
  containsVolontaire: boolean;
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
    .toLowerCase()
    // French CT reports literally print "Défaillance(s) majeure(s)" with
    // the `(s)` parenthetical pluralisation. Three OCR variants observed
    // in the wild break a strict `\(s\)` replacer:
    //   - "Defaillance (s)"  ← pdfjs splits items, inserting a space
    //   - "Defaillance!s)"   ← Tesseract reads "(" as "!" on rough scans
    //   - "DEFAILLANCE(S)"   ← handled by the `.toLowerCase()` above
    // The pattern below absorbs any optional whitespace before the
    // bracket, accepts `(`, `!`, or `[` as opener, and `)`, `!`, or `]`
    // as closer. We only fire after a letter so we don't accidentally
    // eat lone "(s)" tokens elsewhere in the text (e.g. lists).
    .replace(/(?<=[a-z])\s*[(!\[]\s*s\s*[)!\]]/g, 's')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCtDefectCodes(section: string): string[] {
  if (!section) return [];
  // Real-world French CT defect codes observed on cdn.vpauto.fr PDFs:
  //   - 4-segment with letter: "1.2.3.a"   (most common)
  //   - 5-segment with letter: "1.2.3.a.1" (sub-detail)
  //   - 3- or 4-segment numeric only: "8.1.1" / "8.1.1.5"
  //
  // OCR variant: Tesseract sometimes reads dots in the code as commas
  // ("4,5,2.a.1" observed on Autosur PVs). We accept `[.,]` between
  // segments and normalise back to dots in the captured string.
  //
  // Phone-number rejection: French phone numbers also look like dotted
  // 2-digit groups ("02.35.75.01.01", "05.56.38.43.23"). They always
  // start with `0`, while defect codes never do (section numbers run
  // 1-9). We therefore require the first segment to start with `[1-9]`,
  // which excludes every phone we've seen in cdn.vpauto.fr PVs without
  // losing any real defect code.
  //
  // The leading `(?<![\w.,])` lookbehind prevents the regex from
  // matching the tail of a longer code (e.g. DEKRA's "Z.0.0.0.2"
  // observation marker would otherwise yield a false "0.0.0.2").
  // The trailing `(?![\w])` lookahead avoids matching "12.05.20" inside
  // dates like "12.05.2024".
  const codes = new Set<string>();
  const pattern = /(?<![\w.,])[1-9]\d?\s*[.,]\s*\d{1,2}\s*[.,]\s*\d{1,2}(?:\s*[.,]\s*[a-z])?(?:\s*[.,]\s*\d{1,2})?(?![\w])/g;
  for (const match of section.matchAll(pattern)) {
    codes.add(match[0].replace(/\s+/g, '').replace(/,/g, '.'));
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
    containsDefauts: /\bdefauts?\b/.test(normalized),
    containsAnomalies: /\banomalies?\b/.test(normalized),
    containsVolontaire: normalized.includes('volontaire'),
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
    // Voluntary-CT variants: some control centres (notably DEKRA on
    // voluntary inspections) prefer the wording "défauts ou anomalies"
    // over "défaillances". The major equivalent gates re-validation
    // exactly like a regulatory "constatées ne permettant pas".
    /defauts?\s+ou\s+anomalies?\s+constatees?\s+\(?\s*ne\s+permettant\s+pas/g,
    /defauts?\s+ou\s+anomalies?\s+majeures?/g,
  ];
  const minorHeaderPatterns = [
    /defaillances?\s+mineures?\s*:?/g,
    /autres?\s+defaillances?\s+constatees?/g,
    // Voluntary-CT minor variants — mirror the patterns above.
    /autres?\s+defauts?\s+ou\s+anomalies?\s+constatees?/g,
    /defauts?\s+ou\s+anomalies?\s+mineures?/g,
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
    // Voluntary-CT "no defect" phrasing — observed verbatim in DEKRA
    // volontaire PVs: "AUCUNE DEFAILLANCE CONSTATEE DANS LE CADRE DU
    // CONTROLE TECHNIQUE VOLONTAIRE" or "aucun défaut ou anomalie
    // constaté(e)".
    || /aucun(?:e)?\s+defauts?\s+ou\s+anomalies?/.test(slice)
    || /aucun(?:e)?\s+defauts?\s+constates?/.test(slice)
    || /n[ée]ant/.test(slice.slice(0, 80));

  const majorEmpty = majorHeader && isExplicitlyEmpty(majorContent);
  const minorEmpty = minorHeader && isExplicitlyEmpty(minorContent);

  let majorCodes = majorHeader && !majorEmpty ? extractCtDefectCodes(majorContent) : [];
  let minorCodes = minorHeader && !minorEmpty ? extractCtDefectCodes(minorContent) : [];

  // Verdict positions — used both for negative-verdict labelling and
  // to break the tie between "Favorable" and "Défavorable" when both
  // appear (regulatory PVs print "Défavorable" as a column label even
  // on Favorable reports — `Informations sur le contrôle technique
  // défavorable`). The verdict is whichever word appears first; the
  // later occurrence is almost always part of a section header.
  const favorableIdx = normalized.search(/\bfavorable\b/);
  const defavorableIdx = normalized.search(/\bdefavorable\b/);
  const contreVisiteIdx = normalized.search(/contre[-\s]?visite/);
  const isFavorable = favorableIdx !== -1
    && (defavorableIdx === -1 || favorableIdx < defavorableIdx);
  const isDefavorable = defavorableIdx !== -1
    && (favorableIdx === -1 || defavorableIdx < favorableIdx);
  const isContreVisite = contreVisiteIdx !== -1;

  // When neither header matched but codes appear elsewhere in the PV
  // (regulatory periodic CTs with no per-severity sub-headings; Autosur
  // ones where Tesseract reads dots as commas), we still want to count
  // them. Classify by verdict:
  //   - Favorable + codes → minor (Favorable means the CT passed; any
  //     codes therefore can only be minor — major would force a contre-
  //     visite or "Défavorable" verdict)
  //   - Défavorable + codes → major
  //   - neither verdict → leave them unclassified
  let unclassifiedCount = 0;
  if (!majorHeader && !minorHeader) {
    const globalCodes = extractCtDefectCodes(normalized);
    if (globalCodes.length > 0) {
      if (isFavorable && !isDefavorable) {
        minorCodes = globalCodes;
      } else if (isDefavorable) {
        majorCodes = globalCodes;
      } else {
        unclassifiedCount = globalCodes.length;
      }
    }
  }

  const majorCount = majorCodes.length;
  const minorCount = minorCodes.length;

  diagnostics.majorCodeCount = majorCount;
  diagnostics.minorCodeCount = minorCount;
  diagnostics.majorCodes = majorCodes;
  diagnostics.minorCodes = minorCodes;

  // Prefix labels with "volontaire" when the PDF is a voluntary CT. A
  // voluntary CT (DEKRA / Norisko / etc. unrequested by the regulator)
  // doesn't replace a regulatory CT — vehicles auctioned with one need
  // a real CT before resale. Tagging the badge keeps that distinction
  // visible without making the user open the PDF.
  const prefix = diagnostics.containsVolontaire ? 'CT volontaire' : 'CT';

  if (majorCount > 0) {
    return {
      summary: {
        label: `${prefix} · ${majorCount} défaut${majorCount > 1 ? 's' : ''} majeur${majorCount > 1 ? 's' : ''}`,
        tone: 'bad',
      },
      diagnostics,
    };
  }

  if (minorCount > 0) {
    return {
      summary: {
        label: `${prefix} · ${minorCount} défaut${minorCount > 1 ? 's' : ''} mineur${minorCount > 1 ? 's' : ''}`,
        tone: 'warn',
      },
      diagnostics,
    };
  }

  if (unclassifiedCount > 0) {
    return {
      summary: {
        label: `${prefix} · ${unclassifiedCount} défaut${unclassifiedCount > 1 ? 's' : ''}`,
        tone: 'warn',
      },
      diagnostics,
    };
  }

  if (isContreVisite) {
    return { summary: { label: `${prefix} · contre-visite`, tone: 'bad' }, diagnostics };
  }
  if (isDefavorable) {
    return { summary: { label: `${prefix} · défavorable`, tone: 'bad' }, diagnostics };
  }

  // No defects, no negative verdict — assume the CT passed. We mark
  // it "(vide)" when the PV explicitly mentions a defects section
  // (défaillance / défauts / anomalies vocabulary): that confirms
  // tesseract did see a defects section and it came back empty,
  // rather than the parser missing it entirely. For voluntary CTs
  // without any defects vocabulary (AutoSecurite voluntary PVs that
  // only show measurement tables), drop "(vide)" — the absence of
  // any defect listing is itself the signal.
  const hasDefectsSectionVocab = diagnostics.containsDefaillance
    || diagnostics.containsDefauts
    || diagnostics.containsAnomalies;
  const hasAnyCtVocab = hasDefectsSectionVocab
    || diagnostics.containsVolontaire
    || /controle\s+technique/.test(normalized);

  if (isFavorable || hasAnyCtVocab) {
    const explicitlyEmpty = hasDefectsSectionVocab
      || !!(majorEmpty)
      || !!(minorEmpty);
    const label = explicitlyEmpty ? `${prefix} OK (vide)` : `${prefix} OK`;
    return { summary: { label, tone: 'ok' }, diagnostics };
  }

  // Not even a CT — return null so the badge falls back to its
  // confirmed-state default ("CT disponible").
  return { summary: null, diagnostics };
}
