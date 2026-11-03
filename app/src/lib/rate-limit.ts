import type { Queryable } from '../db/pool.js';

/**
 * Fixed-window counter stored in Postgres so limits hold across restarts and
 * multiple instances. Returns true when the request is allowed.
 */
export async function hit(db: Queryable, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [bucket, windowSeconds],
  );
  return r.rows[0].count <= limit;
}

export async function pruneRateLimits(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}
