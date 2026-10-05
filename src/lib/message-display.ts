/** Display-only transformations. Stored messages and model context keep their original text. */
export function splitBubbles(
  raw: string,
  separator = '',
  hiddenMarkers: string[] = [],
  streaming = false,
): string[] {
  const markers = [...new Set(hiddenMarkers.filter(Boolean))].sort((a, b) => b.length - a.length);
  const segments = separator ? raw.split(separator) : [raw];
  if (streaming && separator && segments.length) {
    const last = segments.length - 1;
    // Do not flash a delimiter while its remaining tokens are still in flight.
    for (let length = Math.min(separator.length - 1, segments[last].length); length > 0; length--) {
      if (segments[last].endsWith(separator.slice(0, length))) {
        segments[last] = segments[last].slice(0, -length);
        break;
      }
    }
  }
  const visible = segments
    .map((segment, segmentIndex) => {
      let result = '';
      for (let index = 0; index < segment.length;) {
        const full = markers.find((marker) => segment.startsWith(marker, index));
        if (full) {
          index += full.length;
          continue;
        }
        if (
          streaming &&
          segmentIndex === segments.length - 1 &&
          markers.some(
            (marker) =>
              marker.length > segment.length - index && marker.startsWith(segment.slice(index)),
          )
        )
          break;
        result += segment[index++];
      }
      return result.trim();
    })
    .filter(Boolean);
  // Bound the rendered node count without dropping the remaining visible text.
  if (visible.length > 64) return [...visible.slice(0, 63), visible.slice(63).join('\n\n')];
  return visible;
}
