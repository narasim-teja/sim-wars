/**
 * Server-side PDF text extraction using pdfjs-dist.
 *
 * Runs in the Next.js Node runtime (the route opts in via
 * `export const runtime = "nodejs"`). pdfjs-dist 5.x ships ESM-only and
 * needs Node ≥22.13; we're on 24.x.
 *
 * No worker is wired up — we let pdfjs run on the main thread (fine for
 * one-shot server-side extraction; the worker only matters for the browser
 * UI use case).
 */

const MAX_PAGES = 200;
const MAX_CHARS = 500_000;

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  /** True if we hit MAX_PAGES or MAX_CHARS and stopped early. */
  truncated: boolean;
}

export async function extractPdfText(buffer: Uint8Array): Promise<PdfExtractionResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjs.getDocument({
    data: buffer,
    useSystemFonts: false,
    disableFontFace: true,
  });

  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    const pagesToRead = Math.min(pageCount, MAX_PAGES);
    const parts: string[] = [];
    let totalChars = 0;
    let truncated = pageCount > MAX_PAGES;

    for (let i = 1; i <= pagesToRead; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: unknown) => {
          if (item && typeof item === "object" && "str" in item) {
            return (item as { str: string }).str;
          }
          return "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      page.cleanup();

      if (pageText) {
        parts.push(pageText);
        totalChars += pageText.length + 1;
        if (totalChars >= MAX_CHARS) {
          truncated = true;
          break;
        }
      }
    }

    return {
      text: parts.join("\n\n").slice(0, MAX_CHARS),
      pageCount,
      truncated,
    };
  } finally {
    await doc.destroy();
  }
}
