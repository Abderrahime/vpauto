import { describe, it, expect } from 'vitest';
import { parseCtPdfSummary, normalizeCtText, extractCtDefectCodes } from './ctParser';

describe('normalizeCtText', () => {
  it('collapses "Défaillance(s) majeure(s)" to the canonical plural form', () => {
    expect(normalizeCtText('Défaillance(s) majeure(s)')).toBe('defaillances majeures');
  });

  it('handles a space before the (s) marker (pdfjs split-word case)', () => {
    // pdfjs frequently returns the (s) suffix as its own text item, which
    // joining with " " turns into "Defaillance (s) majeure (s)".
    expect(normalizeCtText('Défaillance (s) majeure (s)')).toBe('defaillances majeures');
  });

  it('handles non-breaking and zero-width spaces around colons', () => {
    expect(normalizeCtText('Défaillance(s) majeure(s) :')).toBe('defaillances majeures :');
  });
});

describe('extractCtDefectCodes', () => {
  it('detects 4-segment alphanumeric codes', () => {
    expect(extractCtDefectCodes('1.2.3.a 2.4.5.b')).toEqual(['1.2.3.a', '2.4.5.b']);
  });

  it('detects 3-segment numeric codes', () => {
    expect(extractCtDefectCodes('8.1.1 5.6.7')).toEqual(['8.1.1', '5.6.7']);
  });

  it('detects 5-segment alphanumeric codes', () => {
    expect(extractCtDefectCodes('2.2.4.a.1 freinage avant')).toEqual(['2.2.4.a.1']);
  });

  it('dedupes repeated codes', () => {
    expect(extractCtDefectCodes('1.2.3.a banger 1.2.3.a').length).toBe(1);
  });

  it('ignores dates like 12.05.2024', () => {
    expect(extractCtDefectCodes('Contrôle du 12.05.2024')).toEqual([]);
  });

  it('ignores DEKRA observation marker Z.0.0.0.2', () => {
    expect(extractCtDefectCodes('Z.0.0.0.2 OBSERVATIONS')).toEqual([]);
  });

  it('tolerates whitespace between code segments (pdfjs char-split)', () => {
    expect(extractCtDefectCodes('1 . 2 . 3 . a observation')).toEqual(['1.2.3.a']);
  });
});

describe('parseCtPdfSummary — UTAC-style (Défaillance majeure/mineure)', () => {
  it('returns major count when defects are listed under the major header', () => {
    const text = `
      Procès-verbal du contrôle technique périodique
      Défaillance(s) majeure(s) :
      2.1.1.a Plaquette de frein avant gauche usée
      4.1.1.a Phare avant droit défectueux
      Défaillance(s) mineure(s) :
      Néant
      Résultat du contrôle : défavorable
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(summary?.label).toBe('CT · 2 défauts majeurs');
    expect(summary?.tone).toBe('bad');
    expect(diagnostics.matchedMajorHeader).toBe(true);
    expect(diagnostics.matchedMinorHeader).toBe(true);
    expect(diagnostics.majorCodes).toEqual(['2.1.1.a', '4.1.1.a']);
  });

  it('returns minor count when only minor defects present', () => {
    const text = `
      Défaillance(s) majeure(s) :
      Néant
      Défaillance(s) mineure(s) :
      6.1.2.a Essuie-glace avant détérioré
      8.1.1 Pneumatique avant droit légèrement usé
      Résultat : favorable
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(summary?.label).toBe('CT · 2 défauts mineurs');
    expect(summary?.tone).toBe('warn');
    expect(diagnostics.minorCodes).toEqual(['6.1.2.a', '8.1.1']);
  });

  it('returns "CT OK (vide)" when both sections are explicitly empty', () => {
    const text = `
      Défaillance(s) majeure(s) :
      Néant
      Défaillance(s) mineure(s) :
      Néant
      Résultat du contrôle technique favorable
    `;
    const { summary } = parseCtPdfSummary(text);
    // "(vide)" suffix flags that the parser DID see a defects section
    // (the "Défaillance(s) majeure(s)" / "mineure(s)" headers) and it
    // came back empty — distinguishes "favorable + empty section" from
    // "favorable + no section recognised".
    expect(summary?.label).toBe('CT OK (vide)');
    expect(summary?.tone).toBe('ok');
  });

  it('survives pdfjs-style space-before-(s) split', () => {
    // Simulates what we get after `chunks.join(' ')` when pdfjs returns
    // each "(s)" suffix as its own item.
    const text = `
      Défaillance (s) majeure (s) :
      2.1.1.a Plaquette de frein avant gauche usée
      Défaillance (s) mineure (s) :
      Néant
    `;
    const { summary } = parseCtPdfSummary(text);
    expect(summary?.label).toBe('CT · 1 défaut majeur');
  });
});

describe('parseCtPdfSummary — voluntary CT (DEKRA volontaire "défauts ou anomalies")', () => {
  it('prefixes the label with "CT volontaire" when the PDF mentions it', () => {
    const text = `
      Procès-verbal du contrôle technique VOLONTAIRE
      Défauts ou anomalies constatées (ne permettant pas la validation d'un contrôle technique réglementaire) :
      3.1.2.a Direction — jeu excessif
      Autres défauts ou anomalies constatées :
      6.1.2.a Essuie-glace avant
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsVolontaire).toBe(true);
    expect(diagnostics.containsDefauts).toBe(true);
    expect(diagnostics.matchedMajorHeader).toBe(true);
    expect(diagnostics.matchedMinorHeader).toBe(true);
    expect(summary?.label).toBe('CT volontaire · 1 défaut majeur');
    expect(summary?.tone).toBe('bad');
  });

  it('returns "CT volontaire OK (vide)" when both sections explicitly empty', () => {
    const text = `
      Procès-verbal du contrôle technique VOLONTAIRE
      Défauts ou anomalies constatées (ne permettant pas la validation d'un contrôle technique réglementaire) :
      AUCUNE DEFAILLANCE CONSTATEE DANS LE CADRE DU CONTROLE TECHNIQUE VOLONTAIRE
      Autres défauts ou anomalies constatées :
      AUCUNE DEFAILLANCE CONSTATEE
    `;
    const { summary } = parseCtPdfSummary(text);
    expect(summary?.label).toBe('CT volontaire OK (vide)');
    expect(summary?.tone).toBe('ok');
  });

  it('returns "CT volontaire OK (vide)" when only boilerplate text is extracted', () => {
    // Sample text from the user's console — pdfjs only pulled the
    // legal boilerplate, the actual defect list was further down in the
    // PDF and got cut off by the page-budget. We've decided that a
    // voluntary CT with défauts/défaillance vocabulary + no parsed
    // codes is more usefully labelled "OK (vide)" than the previous
    // pessimistic "à vérifier" — for any of the user's seven sample
    // PDFs the OK reading turned out to be correct.
    const text = `
      procès-verbal de contrôle technique du contrôle volontaire
      date d'imprimé : 001460954
      nature du contrôle du contrôle volontaire
      défauts ou anomalies constatées installation de contrôle
      identité du contrôleur
      le présent procès-verbal résulte d'un contrôle technique dit volontaire
      qui ne peut être assimilé au contrôle technique obligatoire prévu par le code de la route.
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsVolontaire).toBe(true);
    expect(diagnostics.containsDefauts).toBe(true);
    expect(summary?.label).toBe('CT volontaire OK (vide)');
    expect(summary?.tone).toBe('ok');
  });
});

describe('parseCtPdfSummary — DEKRA-style (voluntary control)', () => {
  it('detects major defects via "constatées (ne permettant pas..." header', () => {
    const text = `
      Rapport de contrôle technique volontaire
      Défaillance(s) constatée(s) (ne permettant pas la validation d'un contrôle technique réglementaire) :
      3.1.2.a Direction — jeu excessif
      8.2.1.b Suspension arrière endommagée
      Autre(s) défaillance(s) constatée(s) :
      Néant
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    // "Rapport de contrôle technique volontaire" in the text → label
    // is prefixed with "CT volontaire" so the user sees this isn't a
    // regulatory CT (i.e. doesn't replace one for resale purposes).
    expect(summary?.label).toBe('CT volontaire · 2 défauts majeurs');
    expect(diagnostics.matchedMajorHeader).toBe(true);
    expect(diagnostics.majorCodes).toEqual(['3.1.2.a', '8.2.1.b']);
  });

  it('detects minor defects via "Autre(s) défaillance(s) constatée(s)" header', () => {
    const text = `
      Défaillance(s) constatée(s) (ne permettant pas la validation d'un contrôle technique réglementaire) :
      AUCUNE DEFAILLANCE CONSTATEE DANS LE CADRE DU CONTROLE TECHNIQUE VOLONTAIRE
      Autre(s) défaillance(s) constatée(s) :
      6.1.2.a Essuie-glace avant
      Z.0.0.0.2 OBSERVATIONS Joint d'étanchéité usé
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    // "CONTROLE TECHNIQUE VOLONTAIRE" in the "no defaults" boilerplate
    // also flips the prefix.
    expect(summary?.label).toBe('CT volontaire · 1 défaut mineur');
    expect(diagnostics.minorCodes).toEqual(['6.1.2.a']);
  });

  it('returns "CT OK (vide)" when DEKRA report has no defects', () => {
    const text = `
      Défaillance(s) constatée(s) (ne permettant pas la validation d'un contrôle technique réglementaire) :
      AUCUNE DEFAILLANCE CONSTATEE
      Autre(s) défaillance(s) constatée(s) :
      AUCUNE DEFAILLANCE CONSTATEE
    `;
    const { summary } = parseCtPdfSummary(text);
    // The "défaillance" vocabulary is present (in the section headers
    // and the "AUCUNE DEFAILLANCE" lines) so the parser tags the empty
    // section with "(vide)".
    expect(summary?.label).toBe('CT OK (vide)');
  });
});

describe('parseCtPdfSummary — Securitest-style clean report (favorable verdict, empty section)', () => {
  it('returns "CT OK (vide)" when Favorable + defaillance heading but no subsections or codes', () => {
    // Real Securitest OCR layout — the (6) DEFAILLANCES heading is
    // present but there are no "Défaillances majeures"/"mineures"
    // subsections (those only appear when there are defects). Tesseract
    // sometimes inlines the "Favorable" verdict at the end of the
    // heading line, so the strict "résultat favorable" pattern misses
    // it. We still want to label it OK and mark the section as empty.
    const text = `
      PROCÈS-VERBAL DE CONTRÔLE TECHNIQUE
      Contrôle technique périodique 03/04/2026 26007128
      (7) RÉSULTAT DU CONTRÔLE (6) DÉFAILLANCES ET NIVEAUX DE GRAVITÉ
      Favorable
      (8) LIMITE DE VALIDITÉ DU CONTRÔLE RÉALISÉ
      02/04/2028
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsDefaillance).toBe(true);
    expect(diagnostics.matchedMajorHeader).toBe(false);
    expect(diagnostics.matchedMinorHeader).toBe(false);
    expect(summary?.label).toBe('CT OK (vide)');
    expect(summary?.tone).toBe('ok');
  });

  it('returns "CT OK" (without vide) when Favorable but no defaillance vocabulary at all', () => {
    // Extreme verdict-only case — a one-liner certificate where the
    // OCR didn't pick up any section headers, only the result.
    const text = 'PROCES-VERBAL CONTROLE TECHNIQUE - Resultat: Favorable';
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsDefaillance).toBe(false);
    expect(summary?.label).toBe('CT OK');
    expect(summary?.tone).toBe('ok');
  });
});

describe('parseCtPdfSummary — Autovision-style (plain "Défaillances mineures")', () => {
  it('detects a minor defect code in plural-form header', () => {
    // Real Autovision layout: section heading is "Défaillances mineures"
    // (plain plural, no "(s)" parenthetical) immediately followed by the
    // codes — and the result line says "Favorable".
    const text = `
      PROCÈS-VERBAL DE CONTRÔLE TECHNIQUE
      NATURE DU CONTRÔLE : Contrôle technique périodique
      DATE DU CONTRÔLE : 11/05/2026
      RÉSULTAT DU CONTRÔLE : Favorable
      DÉFAILLANCES ET NIVEAUX DE GRAVITÉ
      Défaillances mineures
      8.2.12.e.1. ÉMISSIONS GAZEUSES : Connexion impossible sans dysfonctionnement du témoin OBD
      Kilométrages relevés lors des précédents contrôles techniques depuis le 20 mai 2018 :
      26/03/2026 : 47390 Kms
      NATURE DU PROCHAIN CONTRÔLE : Contrôle technique périodique
    `;
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(summary?.label).toBe('CT · 1 défaut mineur');
    expect(summary?.tone).toBe('warn');
    expect(diagnostics.minorCodes).toContain('8.2.12.e.1');
  });

  it('returns "CT OK (vide)" when vocabulary present but no header regex and no codes', () => {
    // Garbled text: defect vocabulary survives substring checks but
    // neither the major nor the minor header regex matches AND no
    // defect codes were extractable. We used to flag this "à vérifier"
    // (warn tone) defensively. Real-world testing on the user's PVs
    // showed every such case was actually a clean CT — the heading
    // appears in column titles or boilerplate even when the section
    // is empty. We now optimistically label it OK (vide).
    const text = 'défaillance constatée niveau de gravité majeure code illisible';
    const { summary, diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsDefaillance).toBe(true);
    expect(diagnostics.containsMajeure).toBe(true);
    expect(diagnostics.matchedMajorHeader).toBe(false); // header regex didn't fire
    expect(summary?.label).toBe('CT OK (vide)');
    expect(summary?.tone).toBe('ok');
  });
});

describe('parseCtPdfSummary — diagnostics', () => {
  it('flags missing French vocabulary when PDF extraction failed', () => {
    const { summary, diagnostics } = parseCtPdfSummary('garbled chars no defect markers');
    expect(summary).toBeNull();
    expect(diagnostics.containsDefaillance).toBe(false);
    expect(diagnostics.containsMajeure).toBe(false);
  });

  it('confirms French vocabulary presence even when parser fails to find a header', () => {
    // PDF where pdfjs returned char-split text — vocabulary survives the
    // substring check after normalisation but the header regex cannot
    // match because the words are surrounded by extra spaces inside.
    const text = 'd e f a i l l a n c e majeure 2.1.1.a';
    const { diagnostics } = parseCtPdfSummary(text);
    expect(diagnostics.containsMajeure).toBe(true);
    // "defaillance" appears literally even with the spaced original
    // because normalize collapses to "d e f a i l l a n c e majeure"
    // and indexOf('defaillance') needs the contiguous string.
    expect(diagnostics.containsDefaillance).toBe(false);
  });
});
