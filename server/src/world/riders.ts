import { t } from '#src/i18n/index';
import { create, mergeFromJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Schema } from 'effect';
import { Strict } from '#src/schema';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { Random } from '#src/world/geometry';
import { buildRange, isPlaceholderBuild, sizedBodyType, specialtyOf } from '#src/world/pro-build';
import type { ProTraits } from '#src/world/pro-build';

type RiderSpec = Record<string, typeof Schema.Json.Type>;

export const ghostAppearanceSchema = Strict({
  is_male: Schema.optional(Schema.Boolean),
  random_body: Schema.optional(Schema.Boolean),
  country_code: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bike_frame: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bike_frame_colour: Schema.optional(
    Schema.Union([Schema.String.check(Schema.isPattern(/^\d+$/)), Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]),
  ),
  bike_wheel_front: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bike_wheel_rear: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  glasses_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ride_jersey: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ride_helmet_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ride_shoes_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ride_socks_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  run_shirt_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  run_shorts_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  run_shoes_type: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export class RiderPool {
  private nameIndex = 0;

  /** Place of each rider of the riders file among those of the same sex, best first. */
  private readonly ranks = new Map<RiderSpec, number>();

  /** Rank and specialty of every profile made here, by player ID. */
  private readonly traits = new Map<bigint, ProTraits>();

  readonly dictionary: RiderSpec;

  readonly names: ReadonlyArray<RiderSpec>;

  constructor(
    assets: string,
    ridersFile: string,
    readonly rng = new Random(),
  ) {
    this.dictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(readFileSync(resolve(assets, 'data/game_dictionary.txt'), 'utf8')),
    );

    if (ridersFile) {
      this.names = Schema.decodeUnknownSync(
        Schema.Struct({ riders: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
      )(JSON.parse(readFileSync(ridersFile, 'utf8'))).riders;
      const counts = { male: 0, female: 0 };

      for (const spec of this.names) {
        const sex = spec.is_male === false || spec.isMale === false ? 'female' : 'male';
        const place = counts[sex]++;
        // An explicit rank, such as a place in a pro ranking, wins over the place in the file.
        this.ranks.set(spec, typeof spec.rank === 'number' && Number.isFinite(spec.rank) ? spec.rank : place);
      }
    } else {
      const names = Schema.decodeUnknownSync(
        Schema.Struct({
          male_first_names: Schema.Array(Schema.String),
          female_first_names: Schema.Array(Schema.String),
          last_names: Schema.Array(Schema.String),
        }),
      )(JSON.parse(readFileSync(resolve(assets, 'data/names.txt'), 'utf8')));

      this.names = Array.from({ length: 1000 }, () => {
        const male = rng.value() > 0.5;

        return {
          first_name: rng.pick(male ? names.male_first_names : names.female_first_names),
          last_name: rng.pick(names.last_names),
          is_male: male,
          country_code: rng.pick(Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(this.dictionary.country_codes)),
        };
      });
    }
  }

  /** Rank and specialty of a profile made here; unranked all-rounders for anything else. */
  traitsOf(id: bigint): ProTraits {
    return this.traits.get(id) ?? { rank: Infinity, specialty: 'rouleur' };
  }

  customizeGhost(profile: PlayerProfile, appearance: (typeof ghostAppearanceSchema)['Type']) {
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
      ] as const) {
        mergeFromJson(PlayerProfileSchema, profile, { [field]: body[field] });
      }
    }

    // The JSON round trip yields the JSON form mergeFromJson expects; structuredClone would keep non-JSON values.
    // oxlint-disable-next-line unicorn/prefer-structured-clone, typescript/no-unsafe-argument
    mergeFromJson(PlayerProfileSchema, profile, JSON.parse(JSON.stringify(equipment)));
  }

  profile(id: bigint, overrides: Record<string, typeof Schema.Json.Type | undefined> = {}, onlyKitted = false) {
    const rng = this.rng;

    const kitted = this.names.filter((name) => name.ride_jersey || name.rideJersey);

    const available = onlyKitted && kitted.length > 0 ? kitted : this.names;
    const source = available[this.nameIndex++ % available.length] ?? {};

    const profile = create(PlayerProfileSchema, {
      id,
      firstName: t('rider'),
      lastName: String(id),
      isMale: rng.value() > 0.5,
      weightInGrams: Math.round(rng.between(62, 86) * 1000),
      privacyBits: 4n,
      heightInMillimeters: Math.round(rng.between(165, 192) * 10),
    });

    const choose = (key: string) =>
      rng.pick(Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(this.dictionary[key]));

    profile.rideHelmetType = choose('headgears');
    profile.glassesType = choose('glasses');
    profile.rideShoesType = choose('bikeshoes');
    profile.rideSocksType = choose('socks');
    profile.rideSocksLength = Math.floor(rng.between(0, 4));
    profile.rideJersey = choose('jerseys');

    const wheels = rng.pick(
      Schema.decodeUnknownSync(Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])))(this.dictionary.wheels),
    );

    profile.bikeWheelRear = wheels[0];
    profile.bikeWheelFront = wheels[1];
    profile.bikeFrame = Number(
      rng.pick(
        Object.keys(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(this.dictionary.bikeframes)),
      ),
    );
    profile.runShirtType = choose('runshirts');
    profile.runShortsType = choose('runshorts');
    profile.runShoesType = choose('runshoes');
    profile.hairType = choose('hair_types');
    profile.hairColour = Math.floor(rng.between(0, 5));

    function apply(spec: Record<string, typeof Schema.Json.Type | undefined>) {
      const values: RiderSpec = {};

      for (const field of PlayerProfileSchema.fields) {
        const value = spec[field.localName] ?? spec[field.name];

        if (value !== undefined) {
          values[field.jsonName] = value;
        }
      }

      // SAFETY: decoded JSON values are plain JSON; protobuf only reads them.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      mergeFromJson(PlayerProfileSchema, profile, values as JsonValue, {
        ignoreUnknownFields: true,
      });
    }

    apply(source);
    apply(overrides);

    const specialty = specialtyOf(source.specialty, profile.weightInGrams / 1000, profile.heightInMillimeters);
    const rank = this.ranks.get(source) ?? Infinity;
    this.traits.set(id, { rank, specialty });

    // Riders file entries without real data get a build that suits their specialty.
    if (this.ranks.has(source) && isPlaceholderBuild(profile.weightInGrams, profile.heightInMillimeters)) {
      const build = buildRange(specialty, profile.isMale);
      profile.weightInGrams = Math.round(rng.between(...build.weight) * 1000);
      profile.heightInMillimeters = Math.round(rng.between(...build.height) / 10) * 10;
    }

    const bodies = Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(
      this.dictionary[profile.isMale ? 'body_types_male' : 'body_types_female'],
    );
    // Keep the face and skin of the riders file; the size follows the build, never chance.
    const body = bodies.includes(profile.bodyType) && this.ranks.has(source) ? profile.bodyType : rng.pick(bodies);
    profile.bodyType = sizedBodyType(body, profile.weightInGrams / 1000, profile.heightInMillimeters, profile.isMale);

    if (profile.isMale) {
      profile.facialHairType = choose('facial_hair_types');
      profile.facialHairColour = Math.floor(rng.between(0, 5));
    }

    return profile;
  }
}
