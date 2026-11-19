/** API error bodies. */

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
