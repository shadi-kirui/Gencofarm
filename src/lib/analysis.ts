export type AnalysisScope =
  | "overview"
  | "livestock-analytics"
  | "performance-report"
  | "sales-report";

export interface AnalysisRequest {
  scope: AnalysisScope;
  programme?: string | null;
  dateRange?: { startDate?: string; endDate?: string } | null;
  timeFrame?: "weekly" | "monthly" | "yearly" | string | null;
  selectedYear?: number | string | null;
  target?: number | null;
  salesInputs?: { pricePerKg?: number | string | null; expenses?: number | string | null } | null;
}

export const fetchAnalysisSummary = async (request: AnalysisRequest): Promise<any> => {
  throw new Error(
    `Remote analysis summary is disabled for ${request.scope}. Use the page-specific collection loaders instead.`,
  );
};
