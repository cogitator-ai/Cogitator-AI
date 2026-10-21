/**
 * Apply OpenAI cursor pagination (`after` / `before` ids) to an ordered list: `after` gives the
 * `limit` items right after the cursor, `before` the `limit` items right before it, in list order.
 * `has_more` tells whether more items lie beyond the page, away from the cursor (past the end for
 * `after` or no cursor, before the start for `before`). An unknown cursor id is ignored.
 */
export function paginate<T extends { id: string }>(
  items: T[],
  options: { limit: number; after?: string; before?: string }
): { data: T[]; has_more: boolean; first_id?: string; last_id?: string } {
  const window = cursorWindow(items, options);
  const data = options.before
    ? window.slice(Math.max(0, window.length - options.limit))
    : window.slice(0, options.limit);
  return {
    data,
    has_more: window.length > options.limit,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
  };
}

/** The items strictly between the `after` and `before` cursors, in list order. */
export function cursorWindow<T extends { id: string }>(
  items: T[],
  options: { after?: string; before?: string }
): T[] {
  let list = items;
  if (options.after) {
    const idx = list.findIndex((item) => item.id === options.after);
    if (idx !== -1) list = list.slice(idx + 1);
  }
  if (options.before) {
    const idx = list.findIndex((item) => item.id === options.before);
    if (idx !== -1) list = list.slice(0, idx);
  }
  return list;
}
