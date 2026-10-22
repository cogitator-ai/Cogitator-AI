/** The rank of each value from 1 up, tied values sharing the mean of their ranks */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end++;
    const rank = (start + end) / 2 + 1;
    for (let at = start; at <= end; at++) ranks[order[at].index] = rank;
    start = end + 1;
  }
  return ranks;
}

/** The sizes of the groups of tied values, groups of one left out */
export function tieGroups(values: readonly number[]): number[] {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1);
}
