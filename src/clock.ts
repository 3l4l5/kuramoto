export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** テスト用。進めた分だけ時間が経つ。 */
export class ManualClock implements Clock {
  constructor(private t = new Date("2026-11-07T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function iso(d: Date): string {
  return d.toISOString();
}
