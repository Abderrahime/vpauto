// Backend OCR helper for scanner-only CT PDFs.
//
// French CT certificates issued by some control centres are scanned with
// office multi-function printers (Lexmark Scan Center, KONICA bizhub …)
// before being uploaded to cdn.vpauto.fr. The resulting PDFs are a
// single embedded JPEG with no text layer — pdfjs cannot extract a
// single character from them.
//
// This module renders such a PDF to JPEG pages using the `pdftoppm`
// binary (from poppler-utils) and runs Tesseract on each page. Results
// are cached in-memory by URL so repeated requests for the same PDF
// (page reloads, list pagination, side-panel re-opens) skip the
// 2-3 seconds of OCR.
//
// External dependencies (one-time install, e.g. `brew install …`):
//   - poppler        — provides the `pdftoppm` binary
//   - tesseract      — OCR engine
//   - tesseract-lang — French language data (`fra.traineddata`)

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cap the wall-clock budget so one slow PDF can't block the API
// indefinitely. Real-world OCR on the user's Lexmark scans averages
// 1.5 s/page on an M2 — 60 s is comfortably above the worst case.
const OCR_TIMEOUT_MS = 60_000;
// Limit the number of pages we OCR. CT certificates are usually 1 page,
// occasionally 2-3 for multi-vehicle reports. Anything deeper is
// likely irrelevant and burns CPU.
const MAX_PAGES = 4;
// 200 DPI is the sweet spot for printed-then-scanned French text:
// Tesseract accuracy plateaus above 200, and going higher just makes
// each page bigger and slower without improving results.
const RENDER_DPI = 200;

export type CtOcrResult = {
  text: string;
  pages: number;
  bytes: number;
  ocrMs: number;
  fromCache: boolean;
};

// Process-wide cache keyed by URL. The backend handles dozens of
// extension users hitting the same handful of URLs (the same vehicle
// list is loaded many times), so a per-process cache hits >95 % once
// the SW has warmed up. We accept the trade-off of losing the cache
// when the backend restarts — it's a few seconds of re-work.
const ocrCache = new Map<string, CtOcrResult>();
// Track in-flight OCR jobs so concurrent requests for the same URL
// share a single execution instead of racing.
const inFlight = new Map<string, Promise<CtOcrResult>>();

function isAllowedCtPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'cdn.vpauto.fr'
      && /_CT\.pdf$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function runCommand(
  bin: string,
  args: string[],
  input?: Buffer,
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        code: code ?? -1,
      });
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function fetchPdf(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'VPauto-Backend-OCR/1.0' },
  });
  if (!response.ok) {
    throw new Error(`pdf_fetch_http_${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function pdfToJpegs(pdfBytes: Buffer, workDir: string): Promise<string[]> {
  // pdftoppm writes `output-1.jpg`, `output-2.jpg`, … in workDir. We
  // pipe the PDF via stdin so we don't need an input file on disk.
  const outputPrefix = join(workDir, 'page');
  const args = [
    '-jpeg',
    '-r', String(RENDER_DPI),
    '-l', String(MAX_PAGES),   // stop after N pages
    '-',                        // read PDF from stdin
    outputPrefix,
  ];
  const { stderr, code } = await runCommand('pdftoppm', args, pdfBytes);
  if (code !== 0) {
    throw new Error(`pdftoppm_exit_${code}: ${stderr.slice(0, 200)}`);
  }
  const files = await readdir(workDir);
  return files
    .filter((name) => name.startsWith('page-') && name.endsWith('.jpg'))
    .sort()
    .map((name) => join(workDir, name));
}

async function ocrJpeg(jpegPath: string): Promise<string> {
  // `tesseract <input> - -l fra` writes plain text to stdout.
  // `--psm 4` = "Assume a single column of text of variable sizes",
  // which matches CT PV layouts better than the default `auto` mode
  // (Tesseract sometimes treats the table as multiple columns and
  // shuffles cell order).
  const args = [jpegPath, '-', '-l', 'fra', '--psm', '4'];
  const { stdout, stderr, code } = await runCommand('tesseract', args);
  if (code !== 0) {
    throw new Error(`tesseract_exit_${code}: ${stderr.slice(0, 200)}`);
  }
  return stdout.toString('utf8');
}

// Minimum text length to consider an OCR result "useful" enough to
// cache. CT PVs always carry hundreds of characters once the header,
// vehicle plate and result block are read. Below this threshold we
// assume tesseract failed to recognise anything meaningful (blank
// page, very low-quality scan, wrong language config) and we let the
// next request retry from scratch instead of pinning a useless cached
// empty answer that breaks the badge for the rest of the session.
const MIN_USEFUL_OCR_CHARS = 80;

async function runOcrPipeline(url: string): Promise<CtOcrResult> {
  const start = Date.now();
  const pdfBytes = await fetchPdf(url);
  const workDir = await mkdtemp(join(tmpdir(), 'vpauto-ct-ocr-'));
  try {
    const jpegPaths = await pdfToJpegs(pdfBytes, workDir);
    if (jpegPaths.length === 0) {
      // pdftoppm exited 0 but produced no images — typically when the
      // PDF is corrupt or pdftoppm's MAX_PAGES range is beyond the
      // document. Don't pretend OCR succeeded.
      console.warn(`[VPauto OCR] pdftoppm produced 0 images for ${url}`);
      throw new Error('ocr_no_pages_rendered');
    }
    const pageTexts: string[] = [];
    for (const jpegPath of jpegPaths) {
      pageTexts.push(await ocrJpeg(jpegPath));
    }
    const text = pageTexts.join('\n\n----- PAGE -----\n\n');
    const trimmedLength = text.trim().length;
    const result: CtOcrResult = {
      text,
      pages: jpegPaths.length,
      bytes: pdfBytes.length,
      ocrMs: Date.now() - start,
      fromCache: false,
    };
    console.log(
      `[VPauto OCR] ${url} — pages=${jpegPaths.length} pdf=${pdfBytes.length}B `
      + `text=${trimmedLength}chars ms=${result.ocrMs}`,
    );
    if (trimmedLength >= MIN_USEFUL_OCR_CHARS) {
      ocrCache.set(url, { ...result, fromCache: true });
    } else {
      // Don't cache near-empty results — next time we want to retry,
      // not return the same useless empty string. Tag the failure so
      // the API caller can distinguish "real OCR but nothing readable"
      // from "OCR didn't run at all".
      console.warn(
        `[VPauto OCR] result too short (${trimmedLength} chars) for ${url} — not caching`,
      );
    }
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function ocrCtPdf(url: string): Promise<CtOcrResult> {
  if (!isAllowedCtPdfUrl(url)) {
    throw new Error('invalid_ct_pdf_url');
  }

  const cached = ocrCache.get(url);
  if (cached) {
    return cached;
  }

  const ongoing = inFlight.get(url);
  if (ongoing) {
    return ongoing;
  }

  const promise = (async () => {
    try {
      return await Promise.race([
        runOcrPipeline(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ocr_timeout')), OCR_TIMEOUT_MS),
        ),
      ]);
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, promise);
  return promise;
}

export function ocrCacheStats(): { size: number; urls: string[] } {
  return { size: ocrCache.size, urls: Array.from(ocrCache.keys()) };
}
