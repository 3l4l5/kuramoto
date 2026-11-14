import { createHash, randomBytes } from "node:crypto";

/** 画面の Cookie に入れるセッションの有効期間(ミリ秒)。短くして、漏れても長く使われないようにする(ADR-0061)。 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 画面(ブラウザ)に渡すセッション(ADR-0061)。
 * Cookie はポートで分けられず、担当が立てた localhost の別ポートのサーバーにも送られる。
 * そこで Cookie には、合言葉そのものではなく、本体だけが覚えているセッション ID を入れる。
 * - 合言葉(~/.kuramoto/access-token)は Cookie にもどこにも出ない。漏れても、ID の分だけ(有効期間内)で済む。
 * - 本体は ID のハッシュだけを覚える(メモリの中。再起動で全部失効する)。期限が切れたもの・失効させたものは通さない。
 * - 失効: 1 つ(ログアウト)・全部(`revokeAll`)。合言葉を作り直さなくても、漏れた ID を止められる。
 */
export class Sessions {
  /** ID のハッシュ → 期限(ミリ秒)。 */
  private readonly live = new Map<string, number>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 新しいセッションを作り、ID を返す(Cookie に入れる値)。ついでに期限切れを捨てる。 */
  issue(): string {
    this.sweep();
    const id = randomBytes(32).toString("base64url");
    this.live.set(hash(id), this.now() + this.ttlMs);
    return id;
  }

  /** 通してよい ID か。期限切れは捨てる。 */
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const key = hash(id);
    const until = this.live.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.live.delete(key);
      return false;
    }
    return true;
  }

  /** この ID のセッションを失効させる(ログアウト)。 */
  revoke(id: string | undefined): void {
    if (id) this.live.delete(hash(id));
  }

  /** すべてのセッションを失効させる(漏れた疑いがあるとき)。止めた数を返す。 */
  revokeAll(): number {
    const n = this.live.size;
    this.live.clear();
    return n;
  }

  /** 有効なセッションの数(試験用)。 */
  get size(): number {
    this.sweep();
    return this.live.size;
  }

  get maxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, until] of this.live) if (until <= t) this.live.delete(k);
  }
}

function hash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
