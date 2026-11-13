/** A size for people: whole kilobytes rounded up, megabytes with at most one decimal ("10 MB", "1.5 MB"). */
export function formatBytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${Number((bytes / 1_048_576).toFixed(1))} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
