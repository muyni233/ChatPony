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
