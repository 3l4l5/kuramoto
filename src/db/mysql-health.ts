/**
 * MySQL に繋がっているかの見張り(ADR-0041)。
 *  - 一定の間隔で ping し、返らなければ「切れた」にする。クエリが接続のエラーで落ちたとき(reportFailure)も、すぐ「切れた」にする。
 *  - 切れている間も ping を続け、返ったら「繋がった」に戻す。切れた・戻ったは listener に知らせる。
 *  - 受信箱の見回りとエージェントの起動は、切れている間は止めて待つ(server.ts・dispatcher.ts が isUp() を見る)。
 */
export type DbHealthState = { up: true } | { up: false; since: string; error: string };

/** 接続が切れた・届かないことを表すエラーか(SQL の間違いなどと区別する) */
export function isConnectionError(e: unknown): boolean {
  const err = e as { code?: string; fatal?: boolean } | null;
  if (!err) return false;
  if (err.fatal === true) return true;
  return typeof err.code === "string" && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR|ER_CON_COUNT_ERROR|ER_SERVER_SHUTDOWN|CR_SERVER_GONE_ERROR|CR_SERVER_LOST)$/.test(err.code);
}

export type DbHealthOptions = {
  /** ping の間隔(ミリ秒)。既定は 5 秒 */
  intervalMs?: number;
  now?: () => Date;
};

export class DbHealth {
  private state: DbHealthState = { up: true };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private checking: Promise<void> | undefined;
  private readonly listeners = new Set<(s: DbHealthState) => void>();
  private readonly intervalMs: number;
  private readonly now: () => Date;

  /** ping: 繋がっていれば返り、切れていれば投げる関数 */
  constructor(private readonly ping: () => Promise<void>, opts: DbHealthOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.now = opts.now ?? (() => new Date());
  }

  isUp(): boolean {
    return this.state.up;
  }

  current(): DbHealthState {
    return this.state;
  }

  /** 状態が変わったときに呼ぶ。外すときは返り値の関数を呼ぶ。 */
  onChange(fn: (s: DbHealthState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** いますぐ 1 回確かめる。重なって呼ばれたら、動いている確認の結果を待つ。 */
  check(): Promise<void> {
    this.checking ??= this.ping().then(
      () => this.setUp(),
      (e) => this.setDown(e),
    ).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /** クエリが接続のエラーで落ちたとき、呼び出し側が知らせる。接続のエラーでなければ何もしない。 */
  reportFailure(e: unknown): void {
    if (isConnectionError(e)) this.setDown(e);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private setDown(e: unknown): void {
    if (!this.state.up) return;
    const msg = e instanceof Error ? e.message : String(e);
    this.state = { up: false, since: this.now().toISOString(), error: msg.split("\n")[0]!.slice(0, 300) };
    this.emit();
  }

  private setUp(): void {
    if (this.state.up) return;
    this.state = { up: true };
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(this.state);
      } catch {
        // 知らせる側の失敗で見張りを止めない
      }
    }
  }
}
