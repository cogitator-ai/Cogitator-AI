import parser from 'cron-parser';

export function getNextCronMs(
  expression: string,
  from: number = Date.now(),
  timezone?: string
): number {
  const interval = parser.parseExpression(expression.trim(), {
    currentDate: new Date(from),
    ...(timezone ? { tz: timezone } : {}),
  });
  return interval.next().getTime();
}
