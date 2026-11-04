import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

// Fork: a turn start or rollback holds its worktree's lease while recreating that worktree,
// and the recreation takes the same lease again; a plain semaphore deadlocked (registry 66).
// Re-entry is allowed only while the outer hold is still active, so a fiber forked inside a
// lease that outlives it takes the lease normally.
const HeldWorkspaceLeases = Context.Reference<ReadonlyMap<string, { active: boolean }>>(
  "t3/workspace/workspaceLease/HeldWorkspaceLeases",
  { defaultValue: () => new Map() },
);

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(HeldWorkspaceLeases), (held) => {
    if (held.get(cwd)?.active === true) return effect;
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore
      .withPermit(
        Effect.suspend(() => {
          const hold = { active: true };
          return effect.pipe(
            Effect.provideService(HeldWorkspaceLeases, new Map([...held, [cwd, hold]])),
            Effect.ensuring(
              Effect.sync(() => {
                hold.active = false;
              }),
            ),
          );
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lease.users--;
            if (lease.users === 0) leases.delete(cwd);
          }),
        ),
      );
  });
