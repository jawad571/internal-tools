import { and, eq, exists, gt, sql } from 'drizzle-orm';
import { editions, preferences, userSources, users } from '../db/schema.ts';
import type { Deps } from '../shared/deps.ts';
import { nextSlot } from '../shared/time.ts';

const INSERT_BATCH = 1000;

/**
 * One read of all eligible users, slot maths in JS (per-zone), then batched inserts. The unique
 * (user_id, slot_at) index makes concurrent or repeated runs harmless.
 */
export async function scheduleDueEditions(deps: Deps): Promise<number> {
  const { db, config } = deps;
  const now = deps.now();
  const activeSince = new Date(now.getTime() - config.IDLE_PAUSE_DAYS * 86_400_000);
  const leadMs = config.SCHEDULE_LEAD_MINUTES * 60_000;

  const candidates = await db
    .select({
      userId: users.id,
      timezone: users.timezone,
      voiceId: preferences.voiceId,
      tone: preferences.tone,
      standardMinutes: preferences.standardMinutes,
      extendedMinutes: preferences.extendedMinutes,
      activeHours: preferences.activeHours,
      extendedHours: preferences.extendedHours,
    })
    .from(users)
    .innerJoin(preferences, eq(preferences.userId, users.id))
    .where(
      and(
        eq(preferences.paused, false),
        gt(users.lastActiveAt, activeSince),
        sql`cardinality(${preferences.activeHours}) > 0`,
        exists(db.select({ one: sql`1` }).from(userSources).where(eq(userSources.userId, users.id))),
      ),
    );

  const rows = candidates.flatMap((u) => {
    let slot;
    try {
      slot = nextSlot(now, u.timezone);
    } catch {
      return []; // invalid zone stored; the server validates, so this is defensive only
    }
    if (Number.isNaN(slot.slotAt.getTime()) || slot.slotAt.getTime() - now.getTime() > leadMs) return [];
    if (!u.activeHours.includes(slot.localHour)) return [];
    const extended = u.extendedHours.includes(slot.localHour);
    return [
      {
        userId: u.userId,
        slotAt: slot.slotAt,
        localHour: slot.localHour,
        kind: extended ? ('extended' as const) : ('standard' as const),
        trigger: 'scheduled' as const,
        targetSeconds: (extended ? u.extendedMinutes : u.standardMinutes) * 60,
        voiceId: u.voiceId,
        tone: u.tone,
      },
    ];
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const res = await db
      .insert(editions)
      .values(rows.slice(i, i + INSERT_BATCH))
      .onConflictDoNothing({ target: [editions.userId, editions.slotAt] })
      .returning({ id: editions.id });
    inserted += res.length;
  }
  return inserted;
}
