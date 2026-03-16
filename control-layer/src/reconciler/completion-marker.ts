export function normalizeCompletionMarkerText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[\s-]+/g, '')
    .trim();
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countCompletionMarkerOccurrences(output: string, marker: string): number {
  const normalizedMarker = normalizeCompletionMarkerText(marker);
  if (!normalizedMarker) {
    return 0;
  }

  const normalizedOutput = output.replace(/\r\n/g, '\n');
  const markerPattern = normalizedMarker
    .split('')
    .map((char) => escapeForRegex(char))
    .join('[\\s-]*');
  const markerRegex = new RegExp(
    `(?<![A-Za-z0-9_])${markerPattern}(?![A-Za-z0-9_])`,
    'g',
  );

  return Array.from(normalizedOutput.matchAll(markerRegex)).length;
}

export function hasRepeatedCompletionMarker(output: string, marker: string): boolean {
  return countCompletionMarkerOccurrences(output, marker) >= 2;
}
