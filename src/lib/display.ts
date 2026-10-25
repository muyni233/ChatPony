import type { PlatformSettings } from './types';

type DisplayOptions = Pick<PlatformSettings, 'bubbleDelimiter' | 'hiddenSymbols'>;

/** Display rules are literal strings, never executable regular expressions. */
export function stripDisplaySymbols(content: string, settings?: Partial<DisplayOptions>): string {
  const symbols = [...new Set(settings?.hiddenSymbols || [])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!symbols.length) return content;
  // A single pass prevents one removal from creating a new symbol spanning two original boundaries.
  let result = '';
  for (let index = 0; index < content.length; ) {
    const found = symbols.find((symbol) => content.startsWith(symbol, index));
    if (found) index += found.length;
    else {
      result += content[index];
      index++;
    }
  }
  return result;
}

export function messageBubbles(
  content: string,
  settings?: Partial<DisplayOptions>,
  split = true,
): string[] {
  const parts =
    split && settings?.bubbleDelimiter ? content.split(settings.bubbleDelimiter) : [content];
  return parts.map((part) => stripDisplaySymbols(part, settings).trim()).filter(Boolean);
}

export function visibleMessage(
  content: string,
  settings?: Partial<DisplayOptions>,
  split = true,
): string {
  return messageBubbles(content, settings, split).join('\n\n');
}

export type DisplaySegment = { kind: 'text' | 'action'; text: string };
type ActionOptions = Partial<
  Pick<PlatformSettings, 'actionStyleEnabled' | 'actionMarkers' | 'actionHideMarkers'>
>;
const DEFAULT_MARKERS = ['* *', '（ ）'];

export function actionMarkerPairs(markers?: string[]): [string, string][] {
  return (markers ?? DEFAULT_MARKERS)
    .map((entry) => entry.split(' '))
    .filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1])
    .sort((left, right) => right[0].length - left[0].length);
}

/**
 * Splits role-play text into dialogue and action/narration segments such as
 * *wags tail* or （轻轻点头）. Markers are literal strings; `**bold**` is left
 * alone, and an unclosed marker (for example mid-stream) stays plain text.
 */
export function actionSegments(text: string, options?: ActionOptions): DisplaySegment[] {
  if (options?.actionStyleEnabled === false || !text) return text ? [{ kind: 'text', text }] : [];
  const pairs = actionMarkerPairs(options?.actionMarkers);
  if (!pairs.length) return [{ kind: 'text', text }];
  const hide = options?.actionHideMarkers !== false;
  const segments: DisplaySegment[] = [];
  let plain = '';
  let index = 0;
  const flush = () => {
    if (plain) segments.push({ kind: 'text', text: plain });
    plain = '';
  };
  scan: while (index < text.length) {
    for (const [open, close] of pairs) {
      if (!text.startsWith(open, index)) continue;
      // Leave markdown emphasis such as **bold** untouched.
      if (open === '*' && (text[index + 1] === '*' || text[index - 1] === '*')) continue;
      const start = index + open.length;
      const end = text.indexOf(close, start);
      if (end <= start || end - start > 800) continue;
      const inner = text.slice(start, end);
      if (open === '*' && (/^\s/.test(inner) || /\s$/.test(inner) || text[end + 1] === '*'))
        continue;
      if (inner.includes('\n\n')) continue;
      flush();
      segments.push({ kind: 'action', text: hide ? inner.trim() : open + inner + close });
      index = end + close.length;
      continue scan;
    }
    plain += text[index];
    index++;
  }
  flush();
  return segments;
}
