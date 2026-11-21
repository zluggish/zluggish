import { RuntimeContext } from '#src/context';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import { Context, Effect, Layer } from 'effect';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const flags = context.accounts.repositories.systemFlagsRepository;

  return {
    allowed: Effect.fn('ZwiftUpdatesService.allowed')(() =>
      Effect.sync(() => flags.get(SystemFlag.ZwiftUpdatesAllowed) === 'true'),
    ),
    setAllowed: Effect.fn('ZwiftUpdatesService.setAllowed')((allowed: boolean) =>
      Effect.sync(() => {
        if (allowed) {
          flags.set(SystemFlag.ZwiftUpdatesAllowed, 'true');
        } else {
          flags.clear(SystemFlag.ZwiftUpdatesAllowed);
        }
      }),
    ),
  };
});

export class ZwiftUpdatesService extends Context.Service<ZwiftUpdatesService, Effect.Success<typeof make>>()(
  'zluggish/ZwiftUpdatesService',
) {
  static readonly layer = Layer.effect(ZwiftUpdatesService, make);
}
