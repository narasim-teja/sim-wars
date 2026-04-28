/**
 * Public types for the extraction pipeline. Kept here so client components can
 * import them without bundling pdfjs / openrouter / Node-only modules.
 */

import type { SimulationConfigParsed } from "./schema";

export type { SimulationConfigParsed };

export interface ExtractionOutcome {
  config: SimulationConfigParsed;
  /** Field paths the model populated, e.g. ["token.totalSupply", "staking.baseAPY"]. */
  extractedFields: string[];
  protocolName?: string;
  protocolKind?: string;
  confidence?: number;
  notes?: string;
  source: {
    label: string;
    kind: "pdf" | "url" | "text" | "github-file" | "github-repo";
    filesUsed?: { path: string; bytes: number }[];
    truncated: boolean;
  };
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}
