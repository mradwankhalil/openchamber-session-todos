// Run: bun test
import { describe, expect, test } from 'bun:test';
import { GUEST_POPOVER_DATA_MAX, GUEST_POPOVER_HEIGHT_MAX, GUEST_POPOVER_HEIGHT_MIN, GUEST_POPOVER_WIDTH_MAX, GUEST_POPOVER_WIDTH_MIN, isGuestPopoverRequest } from '@openchamber/sdk';
import { TIP_HEIGHT_MAX, TIP_HEIGHT_MIN, TIP_LABELS, TIP_TEXT_LIMIT, TIP_TEXT_MAX, TIP_WIDTH_MIN, readTip, tipData, tipSize } from '../shared/tip.ts';

describe('the hover tip size', () => {
  test('stays inside the host popover bounds', () => {
    expect(TIP_WIDTH_MIN).toBe(GUEST_POPOVER_WIDTH_MIN);
    expect(TIP_HEIGHT_MIN).toBe(GUEST_POPOVER_HEIGHT_MIN);
    expect(TIP_HEIGHT_MAX).toBe(GUEST_POPOVER_HEIGHT_MAX);
    for (const lines of [[], [0], [12], [180], [5000], Array.from({ length: 200 }, () => 290)]) {
      const { width, height } = tipSize(lines);
      expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(GUEST_POPOVER_WIDTH_MIN);
      expect(width).toBeLessThanOrEqual(GUEST_POPOVER_WIDTH_MAX);
      expect(height).toBeGreaterThanOrEqual(GUEST_POPOVER_HEIGHT_MIN);
      expect(height).toBeLessThanOrEqual(GUEST_POPOVER_HEIGHT_MAX);
    }
  });

  test('a short todo gets the narrowest popover and one line', () => {
    expect(tipSize([40])).toEqual({ width: 160, height: 57 });
  });

  test('a long line wraps at the text column instead of widening further', () => {
    const one = tipSize([TIP_TEXT_MAX - 20]);
    const long = tipSize([TIP_TEXT_MAX * 3]);
    expect(long.width).toBe(TIP_TEXT_MAX + 27);
    expect(long.width).toBe(320);
    expect(one.width).toBeLessThan(long.width);
    expect(long.height).toBeGreaterThan(one.height);
  });

  test('every written line counts, even an empty one', () => {
    expect(tipSize([100, 0, 100]).height).toBeGreaterThan(tipSize([100]).height);
  });
});

describe('the hover tip data', () => {
  test('is what the popover frame reads back', () => {
    expect(readTip(tipData('Ship the fix', 'in_progress'))).toEqual({ text: 'Ship the fix', status: 'in_progress' });
  });

  test('a very long todo is cut so the request stays under the host data limit', () => {
    const data = tipData('x'.repeat(TIP_TEXT_LIMIT * 3), 'pending');
    expect(data.text.length).toBe(TIP_TEXT_LIMIT);
    expect(data.text.endsWith('…')).toBe(true);
    expect(JSON.stringify(data).length).toBeLessThan(GUEST_POPOVER_DATA_MAX);
    const request = { id: 'todo-0-1', anchor: { x: 2, y: 30, width: 240, height: 20 }, side: 'left' as const, ...tipSize([TIP_TEXT_MAX * 40]), data };
    expect(isGuestPopoverRequest(request)).toBe(true);
  });

  test('anything else reads as no tip', () => {
    for (const bad of [null, undefined, 'text', 3, [], {}, { text: '' }, { text: '   ' }, { text: 4 }]) {
      expect(readTip(bad)).toBeNull();
    }
  });

  test('an unknown status falls back to Next', () => {
    expect(readTip({ text: 'a', status: 'blocked' })?.status).toBe('pending');
    expect(readTip({ text: 'a', status: 'toString' })?.status).toBe('pending');
    expect(TIP_LABELS.pending).toBe('Next');
  });
});
