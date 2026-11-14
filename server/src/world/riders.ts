import { create, mergeFromJson } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PlayerProfileSchema, type PlayerProfile } from '#src/protocol/generated/profile_pb';
import { Random } from '#src/world/geometry';

type RiderSpec = Record<string, z.infer<ReturnType<typeof z.json>>>;

export const ghostAppearanceSchema = z.strictObject({
  is_male: z.boolean().optional(),
  random_body: z.boolean().optional(),
  country_code: z.number().int().nonnegative().optional(),
  bike_frame: z.number().int().nonnegative().optional(),
  bike_frame_colour: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).optional(),
  bike_wheel_front: z.number().int().nonnegative().optional(),
  bike_wheel_rear: z.number().int().nonnegative().optional(),
  glasses_type: z.number().int().nonnegative().optional(),
  ride_jersey: z.number().int().nonnegative().optional(),
  ride_helmet_type: z.number().int().nonnegative().optional(),
  ride_shoes_type: z.number().int().nonnegative().optional(),
  ride_socks_type: z.number().int().nonnegative().optional(),
  run_shirt_type: z.number().int().nonnegative().optional(),
  run_shorts_type: z.number().int().nonnegative().optional(),
  run_shoes_type: z.number().int().nonnegative().optional(),
});

export class RiderPool {
  private nameIndex = 0;

  readonly dictionary: RiderSpec;

  readonly names: RiderSpec[];

  constructor(
    assets: string,
    ridersFile: string,
    readonly rng = new Random(),
  ) {
    this.dictionary = z
      .record(z.string(), z.json())
      .parse(JSON.parse(readFileSync(resolve(assets, 'data/game_dictionary.txt'), 'utf8')));

    if (ridersFile)
      this.names = z
        .object({ riders: z.array(z.record(z.string(), z.json())) })
        .parse(JSON.parse(readFileSync(ridersFile, 'utf8'))).riders;
    else {
      const names = z
        .object({
          male_first_names: z.array(z.string()),
          female_first_names: z.array(z.string()),
          last_names: z.array(z.string()),
        })
        .parse(JSON.parse(readFileSync(resolve(assets, 'data/names.txt'), 'utf8')));

      this.names = Array.from({ length: 1000 }, () => {
        const male = rng.value() > 0.5;

        return {
          first_name: rng.pick(male ? names.male_first_names : names.female_first_names),
          last_name: rng.pick(names.last_names),
          is_male: male,
          country_code: rng.pick(z.array(z.number()).parse(this.dictionary.country_codes)),
        };
      });
    }
  }

  customizeGhost(profile: PlayerProfile, appearance: z.infer<typeof ghostAppearanceSchema>) {
    const { random_body: randomBody, ...equipment } = appearance;

    if (randomBody) {
      const body = this.profile(profile.id, appearance.is_male === undefined ? {} : { is_male: appearance.is_male });

      // Merge through protobuf to keep the generated scalar types intact.
      for (const field of [
        'isMale',
        'bodyType',
        'hairType',
        'hairColour',
        'facialHairType',
        'facialHairColour',
      ] as const)
        mergeFromJson(PlayerProfileSchema, profile, { [field]: body[field] });
    }

    mergeFromJson(PlayerProfileSchema, profile, JSON.parse(JSON.stringify(equipment)));
  }

  profile(
    id: bigint,
    overrides: Record<string, z.infer<ReturnType<typeof z.json>> | undefined> = {},
    onlyKitted = false,
  ) {
    const rng = this.rng;

    const kitted = this.names.filter((name) => name.ride_jersey || name.rideJersey);

    const available = onlyKitted && kitted.length > 0 ? kitted : this.names;
    const source = available[this.nameIndex++ % available.length] ?? {};

    const profile = create(PlayerProfileSchema, {
      id,
      firstName: 'Rider',
      lastName: String(id),
      isMale: rng.value() > 0.5,
      weightInGrams: Math.round(rng.between(62, 86) * 1000),
      heightInMillimeters: Math.round(rng.between(165, 192) * 10),
    });

    const choose = (key: string) => rng.pick(z.array(z.number()).parse(this.dictionary[key]));

    profile.rideHelmetType = choose('headgears');
    profile.glassesType = choose('glasses');
    profile.rideShoesType = choose('bikeshoes');
    profile.rideSocksType = choose('socks');
    profile.rideSocksLength = Math.floor(rng.between(0, 4));
    profile.rideJersey = choose('jerseys');

    const wheels = rng.pick(z.array(z.tuple([z.number(), z.number()])).parse(this.dictionary.wheels));

    profile.bikeWheelRear = wheels[0];
    profile.bikeWheelFront = wheels[1];
    profile.bikeFrame = Number(
      rng.pick(Object.keys(z.record(z.string(), z.string()).parse(this.dictionary.bikeframes))),
    );
    profile.runShirtType = choose('runshirts');
    profile.runShortsType = choose('runshorts');
    profile.runShoesType = choose('runshoes');
    profile.hairType = choose('hair_types');
    profile.hairColour = Math.floor(rng.between(0, 5));

    function apply(spec: Record<string, z.infer<ReturnType<typeof z.json>> | undefined>) {
      const values: RiderSpec = {};

      for (const field of PlayerProfileSchema.fields) {
        const value = spec[field.localName] ?? spec[field.name];

        if (value !== undefined) values[field.jsonName] = value;
      }

      mergeFromJson(PlayerProfileSchema, profile, values, {
        ignoreUnknownFields: true,
      });
    }

    apply(source);
    apply(overrides);
    profile.bodyType = choose(profile.isMale ? 'body_types_male' : 'body_types_female');

    if (profile.isMale) {
      profile.facialHairType = choose('facial_hair_types');
      profile.facialHairColour = Math.floor(rng.between(0, 5));
    }

    return profile;
  }
}
