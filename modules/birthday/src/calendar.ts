/** Days in each month in a leap year, so 29 February is a date a member can save. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Whether `day`.`month` exists in some year (29 February included). */
export function isValidBirthday(day: number, month: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12) return false;
  return day >= 1 && day <= (DAYS_IN_MONTH[month - 1] as number);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A moment read on one zone's wall clock. */
export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
}

export function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") };
}

/** The birthdays celebrated on a date: its own, plus 29 February on 28 February of a common year. */
export function celebratedDays({ year, month, day }: LocalTime): number[] {
  return month === 2 && day === 28 && !isLeapYear(year) ? [28, 29] : [day];
}
