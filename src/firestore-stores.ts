/**
 * Firestore implementations of the three shared-state stores (plan step 0a).
 *
 * These are what `assertDeploymentIsSound()` is waiting for: until they exist,
 * a shared deployment correctly refuses to start, because the local defaults
 * (a process-local rate window, a file in $HOME, one shared refresh token) each
 * fail silently on an autoscaled, scale-to-zero service.
 *
 * Firestore rather than ClickHouse: logging to the warehouse
 * would require a write-capable ClickHouse credential on an unattended service,
 * which `docs/agents-registry.md` rules out, and the log is a *source* under the
 * stack's lake-first direction. ClickHouse reads it by sync at Tier 5.
 *
 * Every class takes its Firestore handle by constructor injection. That is not
 * ceremony — it is what lets the tests exercise the real logic (transaction
 * bodies, window trimming, query shape) against a fake, in a repo whose test
 * suite deliberately makes no network calls.
 */
import type {
  RateLimitStore, ActionLogStore, StampedEntry, CredentialStore,
} from "./write-safety";

/**
 * The slice of Firestore these stores use. Narrow on purpose: it is the
 * contract the fake in the tests has to satisfy, so a widening of it is a
 * visible change rather than a silent new dependency on real Firestore.
 */
export type FirestoreLike = {
  collection(path: string): CollectionLike;
  runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T>;
};
export type CollectionLike = {
  doc(id?: string): DocumentLike;
  add(data: Record<string, unknown>): Promise<unknown>;
  orderBy(field: string, dir?: "asc" | "desc"): QueryLike;
};
export type QueryLike = {
  limit(n: number): QueryLike;
  get(): Promise<{ docs: Array<{ data(): Record<string, unknown> }> }>;
};
export type DocumentLike = {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>): Promise<unknown>;
};
export type TransactionLike = {
  get(doc: DocumentLike): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(doc: DocumentLike, data: Record<string, unknown>): void;
};

const WINDOW_MS = 60 * 60 * 1000;

export const COLLECTIONS = {
  rateLimits: "ads_mcp_rate_limits",
  actions: "ads_mcp_actions",
  credentials: "ads_mcp_credentials",
} as const;

/** Lazily construct the real client, so importing this module needs no GCP. */
export function defaultFirestore(): FirestoreLike {
  // Required here rather than at module scope: the tests import this file for
  // its classes and must not need credentials or a project to do so.
  const { Firestore } = require("@google-cloud/firestore");
  return new Firestore() as unknown as FirestoreLike;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
/**
 * The write window, shared across instances.
 *
 * `record()` trims and appends inside a transaction, so two instances writing
 * concurrently cannot lose each other's entries — which is the failure that
 * made the in-memory version give N instances N x the cap.
 *
 * Known bound, stated rather than hidden: `exceeded()` and `record()` are
 * separate calls, so two requests arriving at the exact boundary can both pass
 * the check before either records. The worst case is one write past the cap,
 * and closing it properly means an atomic `tryAcquire` on the interface — a
 * change worth making deliberately, not smuggling in here. At 10 writes per
 * actor per hour, a boundary slip of one is not the risk the cap exists for.
 */
export class FirestoreRateLimitStore implements RateLimitStore {
  readonly kind = "shared" as const;

  constructor(private readonly db: FirestoreLike = defaultFirestore()) {}

  async exceeded(key: string, maxPerHour: number): Promise<boolean> {
    const snap = await this.db.collection(COLLECTIONS.rateLimits).doc(key).get();
    return this.live(snap.exists ? snap.data() : undefined).length >= maxPerHour;
  }

  async record(key: string): Promise<void> {
    const ref = this.db.collection(COLLECTIONS.rateLimits).doc(key);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const stamps = this.live(snap.exists ? snap.data() : undefined);
      stamps.push(Date.now());
      // Trimmed on write, so the document cannot grow without bound on a key
      // that is written to forever.
      tx.set(ref, { stamps });
    });
  }

  /** Timestamps still inside the trailing window. */
  private live(data: Record<string, unknown> | undefined): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const raw = Array.isArray(data?.stamps) ? (data!.stamps as unknown[]) : [];
    return raw.map(Number).filter((t) => Number.isFinite(t) && t >= cutoff);
  }
}

// ── Action log ────────────────────────────────────────────────────────────────
/** Append-only, durable, and readable back by `explain_changes`. */
export class FirestoreActionLogStore implements ActionLogStore {
  readonly kind = "durable" as const;
  readonly location = `firestore://${COLLECTIONS.actions}`;

  constructor(private readonly db: FirestoreLike = defaultFirestore()) {}

  async append(entry: StampedEntry): Promise<void> {
    await this.db.collection(COLLECTIONS.actions).add(entry);
  }

  async tail(limit: number): Promise<string[]> {
    // Newest first from Firestore, then reversed: the local file returns oldest
    // first and `explain_changes` renders in that order, so the two sinks must
    // agree or the same tool reads differently depending on where it runs.
    const snap = await this.db
      .collection(COLLECTIONS.actions)
      .orderBy("ts", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => JSON.stringify(d.data())).reverse();
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────
/**
 * One refresh token per authenticated actor, keyed by Google subject.
 *
 * A missing document is an error, never a fallback to some shared token: an
 * operator whose credential is absent must fail to act, not quietly act as
 * somebody else. That is the whole point of blocker 4.
 */
export class FirestoreCredentialStore implements CredentialStore {
  readonly kind = "per-actor" as const;

  constructor(private readonly db: FirestoreLike = defaultFirestore()) {}

  async refreshTokenFor(actor: string): Promise<string> {
    const snap = await this.db.collection(COLLECTIONS.credentials).doc(actor).get();
    const token = snap.exists ? snap.data()?.refreshToken : undefined;
    if (typeof token !== "string" || !token) {
      throw new Error(
        `No Google Ads credential stored for actor '${actor}'. ` +
        `Add a document at ${COLLECTIONS.credentials}/${actor} with a refreshToken field.`
      );
    }
    return token;
  }

  /**
   * Written by the sign-in callback, and nowhere else: the only way a token
   * enters this collection is its owner completing Google's consent screen.
   * Overwrites, so signing in again replaces a revoked or stale token. The
   * email rides along for a human reading the collection; the key is the sub.
   */
  async save(sub: string, refreshToken: string, email: string): Promise<void> {
    await this.db.collection(COLLECTIONS.credentials).doc(sub).set({
      refreshToken, email, updatedAt: new Date().toISOString(),
    });
  }
}
