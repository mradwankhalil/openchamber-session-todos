import type { TodoStatus } from './model.ts';

// The hover text for a row: the full todo, shown in a host popover beside the
// section. The status frame sizes and opens it; the popover frame (the same page,
// loaded with `surface: 'popover'`) draws it. Pure helpers, testable without a host.

export type TipData = { text: string; status: TodoStatus };

// Host bounds for `openPopover` (the SDK's GUEST_POPOVER_*). Width and height must be integers.
export const TIP_WIDTH_MIN = 160;
export const TIP_HEIGHT_MIN = 48;
export const TIP_HEIGHT_MAX = 480;
// Widest the text column gets before it wraps, in CSS px: the host's subagent
// tooltip is at most 320 px wide, padding and border included.
export const TIP_TEXT_MAX = 293;
// Popover data is JSON capped at 16000 characters; a todo longer than this is cut.
export const TIP_TEXT_LIMIT = 4000;
// Size of the tip text (`.tip-text` in index.html), used to measure it before the popover opens.
export const TIP_FONT_PX = 16.25;

export const TIP_LABELS: Record<TodoStatus, string> = {
  in_progress: 'In progress',
  pending: 'Next',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// The tip page's layout (`#root.tip` in index.html); keep these in step with its CSS.
const PAD_X = 12.5;
const PAD_Y = 6;
const LINE = 24;
const LABEL = 19;
// The host draws a 1px border inside the popover box.
const BORDER = 2;

export const tipData = (text: string, status: TodoStatus): TipData => ({
  text: text.length > TIP_TEXT_LIMIT ? `${text.slice(0, TIP_TEXT_LIMIT - 1)}…` : text,
  status,
});

/** What the popover frame was opened with, or null when it is not a tip. */
export const readTip = (data: unknown): TipData | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { text, status } = data as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '') return null;
  return { text, status: typeof status === 'string' && Object.hasOwn(TIP_LABELS, status) ? status as TodoStatus : 'pending' };
};

/**
 * Popover size for text whose lines measure `lineWidths` px in the tip's font.
 * The width is final: the host cannot widen a popover later. The height is a
 * first guess; the tip page reports its laid-out height and the host follows.
 */
export const tipSize = (lineWidths: number[]): { width: number; height: number } => {
  const widest = lineWidths.reduce((max, width) => Math.max(max, width), 0);
  const column = Math.min(TIP_TEXT_MAX, Math.ceil(widest) + 1);
  const width = Math.max(TIP_WIDTH_MIN, column + PAD_X * 2 + BORDER);
  const inner = width - PAD_X * 2 - BORDER;
  const lines = Math.max(1, lineWidths.reduce((sum, line) => sum + Math.max(1, Math.ceil(line / inner)), 0));
  const height = Math.min(TIP_HEIGHT_MAX, Math.max(TIP_HEIGHT_MIN, Math.ceil(lines * LINE + LABEL + PAD_Y * 2 + BORDER)));
  return { width, height };
};
