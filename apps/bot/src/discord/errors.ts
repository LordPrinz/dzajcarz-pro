/** Whether `error` is a Discord API error with one of `codes` (RESTJSONErrorCodes). */
export function hasCode(error: unknown, ...codes: number[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number" &&
    codes.includes(error.code)
  );
}
