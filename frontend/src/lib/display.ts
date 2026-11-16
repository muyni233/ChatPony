export function stripDisplaySymbols(text: string, hiddenSymbols: string[]): string {
  if (!hiddenSymbols.length) return text;
  let out = text;
  for (const sym of hiddenSymbols) {
    if (sym) {
      out = out.split(sym).join('');
    }
  }
  return out;
}

export function messageBubbles(
  text: string,
  delimiter: string,
  hiddenSymbols: string[] = [],
  split = true
): string[] {
  const cleaned = stripDisplaySymbols(text, hiddenSymbols);
  const sep = delimiter.trim();
  if (!split || !sep) {
    const trimmed = cleaned.trim();
    return trimmed ? [trimmed] : [];
  }
  return cleaned
    .split(sep)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export interface TextSegment {
  text: string;
  action: boolean;
}

export function parseActionSegments(
  text: string,
  enabled: boolean,
  markers: string[],
  hideMarkers: boolean
): TextSegment[] {
  if (!enabled || !markers.length || !text) {
    return [{ text, action: false }];
  }

  const pairs: Array<{ open: string; close: string }> = [];
  for (const m of markers) {
    if (m === '（）') pairs.push({ open: '（', close: '）' });
    else if (m === '()') pairs.push({ open: '(', close: ')' });
    else if (m === '【】') pairs.push({ open: '【', close: '】' });
    else if (m === '[]') pairs.push({ open: '[', close: ']' });
    else if (m === '*' || m === '**' || m === '~') pairs.push({ open: m, close: m });
    else if (m.length === 2) pairs.push({ open: m[0] ?? '', close: m[1] ?? '' });
    else if (m.length >= 1) pairs.push({ open: m, close: m });
  }

  if (!pairs.length) return [{ text, action: false }];

  const segments: TextSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let bestIdx = -1;
    let bestPair: { open: string; close: string } | null = null;
    let bestEnd = -1;

    for (const pair of pairs) {
      if (!pair.open || !pair.close) continue;
      const openIdx = text.indexOf(pair.open, cursor);
      if (openIdx === -1) continue;
      const afterOpen = openIdx + pair.open.length;
      const closeIdx = text.indexOf(pair.close, afterOpen);
      if (closeIdx === -1) continue;
      if (closeIdx === afterOpen) continue;
      // Avoid matching single-asterisk across newlines when multiline narration differs
      const inner = text.slice(afterOpen, closeIdx);
      if (inner.includes('\n')) continue;

      if (bestIdx === -1 || openIdx < bestIdx || (openIdx === bestIdx && pair.open.length > (bestPair?.open.length ?? 0))) {
        bestIdx = openIdx;
        bestPair = pair;
        bestEnd = closeIdx + pair.close.length;
      }
    }

    if (bestIdx === -1 || !bestPair) {
      const rest = text.slice(cursor);
      if (rest) segments.push({ text: rest, action: false });
      break;
    }

    if (bestIdx > cursor) {
      segments.push({ text: text.slice(cursor, bestIdx), action: false });
    }

    const fullSlice = text.slice(bestIdx, bestEnd);
    const innerSlice = text.slice(bestIdx + bestPair.open.length, bestEnd - bestPair.close.length);
    segments.push({
      text: hideMarkers ? innerSlice : fullSlice,
      action: true,
    });
    cursor = bestEnd;
  }

  return segments.length ? segments : [{ text, action: false }];
}

export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'P';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase();
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
