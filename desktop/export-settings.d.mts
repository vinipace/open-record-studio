import type { ExportOptions } from "../src/types";
export const exportFormats: Record<
  ExportOptions["format"],
  {
    heights: number[];
    frameRates: number[];
    height: number;
    fps: number;
  }
>;
export function normalizeExportOptions(
  options: Partial<ExportOptions>,
): ExportOptions;
