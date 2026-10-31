type CronField = {
  matches(value: number): boolean;
};

function parseCronNumber(value: string, min: number, max: number, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${field} cron value: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`Out-of-range ${field} cron value: ${value}`);
  }
  return parsed;
}

function parseCronField(expression: string, min: number, max: number, field: string): CronField {
  const accepted = new Set<number>();
  const parts = expression.split(",");
  if (parts.length === 0) {
    throw new Error(`Invalid ${field} cron field.`);
  }

  for (const part of parts) {
    const [base = "", stepText] = part.split("/");
    const step =
      stepText === undefined ? 1 : parseCronNumber(stepText, 1, max - min + 1, `${field} step`);
    let start = min;
    let end = max;

    if (base !== "*") {
      const range = base.split("-");
      if (range.length === 1) {
        start = parseCronNumber(range[0] ?? "", min, max, field);
        end = stepText === undefined ? start : max;
      } else if (range.length === 2) {
        start = parseCronNumber(range[0] ?? "", min, max, field);
        end = parseCronNumber(range[1] ?? "", min, max, field);
        if (start > end) {
          throw new Error(`Invalid ${field} cron range: ${base}`);
        }
      } else {
        throw new Error(`Invalid ${field} cron field: ${part}`);
      }
    }

    for (let value = start; value <= end; value += step) {
      accepted.add(value);
    }
  }

  return { matches: (value) => accepted.has(value) };
}

export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expressions must have five fields: minute hour day month weekday.");
  }
  const [minute, hour, day, month, weekday] = fields;
  if (!minute || !hour || !day || !month || !weekday) {
    throw new Error("Invalid cron expression.");
  }

  const dayField = parseCronField(day, 1, 31, "day");
  const weekdayField = parseCronField(weekday, 0, 7, "weekday");
  const weekdayValue = date.getUTCDay();
  const dayMatches = dayField.matches(date.getUTCDate());
  const weekdayMatches =
    weekdayField.matches(weekdayValue) || (weekdayValue === 0 && weekdayField.matches(7));
  let calendarDayMatches = dayMatches || weekdayMatches;
  if (day === "*") {
    calendarDayMatches = weekday === "*" || weekdayMatches;
  } else if (weekday === "*") {
    calendarDayMatches = dayMatches;
  }

  return (
    parseCronField(minute, 0, 59, "minute").matches(date.getUTCMinutes()) &&
    parseCronField(hour, 0, 23, "hour").matches(date.getUTCHours()) &&
    parseCronField(month, 1, 12, "month").matches(date.getUTCMonth() + 1) &&
    calendarDayMatches
  );
}

export function assertValidCron(expression: string): void {
  matchesCron(expression, new Date("2026-01-01T00:00:00.000Z"));
}
