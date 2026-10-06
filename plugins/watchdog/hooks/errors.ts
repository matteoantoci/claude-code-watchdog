// The text of a reject, for a log row, a status reason or a deny.
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
