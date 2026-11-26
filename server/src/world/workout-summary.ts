import { t } from '#src/i18n/index';
import { XMLParser } from 'fast-xml-parser';
import { Schema } from 'effect';

/** One power block of a workout, placed back to back from second 0; powers are fractions of FTP. */
export type WorkoutSegment = {
  start: number;
  duration: number;
  from: number;
  to: number;
  range?: { low: number; high: number };
  label?: string;
  cadence?: number;
  interval?: { index: number; count: number };
};

/** What a .zwo file asks for, summarised for display. */
export type WorkoutSummary = {
  name: string;
  durationSeconds: number;
  segments: Array<WorkoutSegment>;
  avgFraction: number;
  normalizedFraction: number;
  intensityFactor: number;
  variabilityIndex: number;
  zoneSeconds: Array<number>;
  approximate: boolean;
};

/** The longest workout somebody rides: a week of seconds. */
const MAX_DURATION_SECONDS = 604_800;
/** Refuse an IntervalsT repeat count beyond it: it is not a workout anymore. */
const MAX_REPEATS = 1000;
/** Coggan zone ceilings as fractions of FTP; Z1 is below the first, Z7 at or above the last. */
const ZONE_LIMITS = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
/** Power of steps whose target we cannot know (FreeRide, MaxEffort). */
const UNKNOWN_FRACTION = 0.55;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

type Attributes = Record<string, string>;

interface TextNode {
  '#text': string;
}

const nodeSchema = Schema.Record(Schema.String, Schema.Json);

type ElementNode = typeof nodeSchema.Type;

const isRecord = Schema.is(nodeSchema);

const isTextNode = (value: unknown): value is TextNode => isRecord(value) && typeof value['#text'] === 'string';

const tagOf = (node: ElementNode): string => Object.keys(node).find((key) => key !== ':@') ?? '';

const isElement = (value: unknown): value is ElementNode =>
  isRecord(value) && !('#text' in value) && tagOf(value) !== '';

const elements = (value: unknown): Array<ElementNode> => (Array.isArray(value) ? value.filter(isElement) : []);

const attributesOf = (node: ElementNode): Attributes => {
  const raw = node[':@'];

  return isRecord(raw)
    ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
};

const textOf = (node: ElementNode): string => {
  const children = node[tagOf(node)];

  return Array.isArray(children)
    ? children
        .filter(isTextNode)
        .map((child) => child['#text'])
        .join('')
    : '';
};

/** Attribute as a number; non-finite (or missing) counts as missing. */
const num = (attributes: Attributes, name: string): number | null => {
  const value = attributes[name];

  if (value === undefined) {
    return null;
  }
  const result = Number(value);

  return Number.isFinite(result) ? result : null;
};

/** Attribute as a number of steps per minute; only a positive finite one counts. */
const cadenceOf = (attributes: Attributes, name: string): number | null => {
  const value = num(attributes, name);

  return value !== null && value > 0 ? value : null;
};

/** First textevent child with a non-empty message; its text labels all segments of the step. */
function labelOf(step: ElementNode): string | null {
  const message = elements(step[tagOf(step)]).find((child) => tagOf(child) === 'textevent');

  if (!message) {
    return null;
  }
  const label = attributesOf(message)['@_message']?.trim();

  return label || null;
}

/** Steps of the workout element, in file order, whatever tags they are. */
function stepsOf(children: unknown): Array<ElementNode> {
  const workout = elements(children).find((node) => tagOf(node) === 'workout');

  return workout ? elements(workout.workout) : [];
}

/** Segments of one step; empty for tags we ignore, null when the step is beyond its limits. */
function segmentsOf(step: ElementNode): Array<WorkoutSegment> | null {
  const tag = tagOf(step);
  const attributes = attributesOf(step);

  if (tag === 'textevent') {
    return [];
  }
  const label = labelOf(step);
  const cadence = cadenceOf(attributes, '@_Cadence');

  const segment = (duration: number | null, from: number, to: number): WorkoutSegment | null => {
    if (duration === null || duration <= 0) {
      return null;
    }
    const built: WorkoutSegment = { start: 0, duration, from, to };

    if (label) {
      built.label = label;
    }
    if (cadence !== null) {
      built.cadence = cadence;
    }

    return built;
  };

  if ([t('warmup'), t('cooldown'), t('ramp')].includes(tag)) {
    // Cooldown and Ramp may go down: PowerLow is the START, PowerHigh the END, as written.
    const one = segment(
      num(attributes, '@_Duration'),
      num(attributes, '@_PowerLow') ?? 0,
      num(attributes, '@_PowerHigh') ?? 0,
    );

    return one ? [one] : [];
  }

  if (tag === 'SteadyState') {
    const constant = num(attributes, '@_Power');
    const low = num(attributes, '@_PowerLow');
    const high = num(attributes, '@_PowerHigh');

    if (constant === null && low !== null && high !== null) {
      // A target RANGE ("ride anywhere in this band"): flat at the mean, band kept for display.
      const mean = (low + high) / 2;
      const one = segment(num(attributes, '@_Duration'), mean, mean);

      return one ? [{ ...one, range: { low: Math.min(low, high), high: Math.max(low, high) } }] : [];
    }
    const from = constant ?? low ?? 0;
    const to = constant ?? high ?? from;
    const one = segment(num(attributes, '@_Duration'), from, to);

    return one ? [one] : [];
  }

  if (tag === 'IntervalsT') {
    const repeat = num(attributes, '@_Repeat');

    if (repeat === null || repeat < 1 || repeat > MAX_REPEATS) {
      return null;
    }
    const onDuration = num(attributes, '@_OnDuration');
    const offDuration = num(attributes, '@_OffDuration');
    const onPower = num(attributes, '@_OnPower') ?? 0;
    const offPower = num(attributes, '@_OffPower') ?? 0;
    const onCadence = cadenceOf(attributes, '@_Cadence');
    const offCadence = cadenceOf(attributes, '@_CadenceResting');
    const on = segment(onDuration, onPower, onPower);
    const off = segment(offDuration, offPower, offPower);

    if (on && onCadence !== null) {
      on.cadence = onCadence;
    }
    if (off && offCadence !== null) {
      off.cadence = offCadence;
    }
    const parts = [on, off].filter((part): part is WorkoutSegment => part !== null);

    if (parts.length === 0) {
      return [];
    }
    const count = Math.trunc(repeat);

    return Array.from({ length: count }, (_, repeatIndex) =>
      parts.map((part) => ({ ...part, interval: { index: repeatIndex + 1, count } })),
    ).flat();
  }

  if (tag === 'FreeRide' || tag === 'MaxEffort') {
    const one = segment(num(attributes, '@_Duration'), UNKNOWN_FRACTION, UNKNOWN_FRACTION);

    return one ? [one] : [];
  }

  return [];
}

/** One entry per second: the segment value at the midpoint of that second, ramps linear. */
function seriesOf(segments: Array<WorkoutSegment>): Array<number> {
  const total = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const series = Array.from<number>({ length: total });
  let start = 0;

  for (const segment of segments) {
    const span = segment.to - segment.from;

    for (let second = 0; second < segment.duration; second += 1) {
      const progress = span === 0 ? 0 : (second + 0.5) / segment.duration;

      series[start + second] = segment.from + span * progress;
    }
    start += segment.duration;
  }

  return series;
}

/** Coggan zone of a fraction of FTP: 0 for Z1 ... 6 for Z7. */
function zoneOf(fraction: number, limits: ReadonlyArray<number>): number {
  let zone = 0;

  while (zone < limits.length && fraction >= (limits[zone] ?? Infinity)) {
    zone += 1;
  }

  return zone;
}

/** Six positive ascending zone ceilings as fractions of FTP; the default when the given ones are unusable. */
function limitsOf(limits: ReadonlyArray<number> | undefined): ReadonlyArray<number> {
  if (!limits || limits.length !== 6 || limits.some((limit) => !(Number.isFinite(limit) && limit > 0))) {
    return ZONE_LIMITS;
  }

  return limits.every((limit, index) => index === 0 || limit > (limits[index - 1] ?? 0)) ? limits : ZONE_LIMITS;
}

type SeriesStats = Pick<WorkoutSummary, 'avgFraction' | 'normalizedFraction' | 'variabilityIndex' | 'zoneSeconds'>;

function summarizeSeries(series: Array<number>, limits: ReadonlyArray<number>): SeriesStats {
  const sum = series.reduce((total, value) => total + value, 0);
  const avgFraction = sum / series.length;

  let normalizedFraction: number;

  if (series.length < 30) {
    normalizedFraction = avgFraction;
  } else {
    let windowSum = 0;

    for (let second = 0; second < 30; second += 1) {
      windowSum += series[second] ?? 0;
    }
    let fourths = Math.pow(windowSum / 30, 4);

    for (let second = 30; second < series.length; second += 1) {
      windowSum += (series[second] ?? 0) - (series[second - 30] ?? 0);
      fourths += Math.pow(windowSum / 30, 4);
    }
    normalizedFraction = Math.pow(fourths / (series.length - 30 + 1), 1 / 4);
  }

  const zoneSeconds = Array.from({ length: 7 }, () => 0);

  for (const value of series) {
    const zone = zoneOf(value, limits);

    zoneSeconds[zone] = (zoneSeconds[zone] ?? 0) + 1;
  }

  return {
    avgFraction,
    normalizedFraction,
    variabilityIndex: avgFraction === 0 ? 1 : normalizedFraction / avgFraction,
    zoneSeconds,
  };
}

/** Name, duration, segments and power statistics of a cycling .zwo; null when it is not one. */
export function summarizeWorkout(zwo: string, zoneLimits?: ReadonlyArray<number>): WorkoutSummary | null {
  let document: unknown;

  try {
    document = parser.parse(zwo);
  } catch {
    return null;
  }

  const root = elements(document).find((node) => tagOf(node) === 'workout_file');

  if (!root) {
    return null;
  }
  const children = elements(root.workout_file);
  const sportType = children.find((node) => tagOf(node) === 'sportType');

  if (sportType) {
    const sport = textOf(sportType).trim().toLowerCase();

    if (sport !== '' && !['bike', 'cycling'].includes(sport)) {
      return null;
    }
  }

  const raw: Array<WorkoutSegment> = [];
  let approximate = false;

  for (const step of stepsOf(children)) {
    const segments = segmentsOf(step);

    if (segments === null) {
      return null;
    }
    if (segments.length > 0 && (tagOf(step) === 'FreeRide' || tagOf(step) === 'MaxEffort')) {
      approximate = true;
    }
    raw.push(...segments);
  }

  if (raw.length === 0) {
    return null;
  }

  // Place segments back to back from second 0.
  let start = 0;
  const segments = raw.map((segment) => ({ ...segment, start: (start += segment.duration) - segment.duration }));
  const durationSeconds = start;

  if (durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    return null;
  }

  const name = children.find((node) => tagOf(node) === 'name');
  const stats = summarizeSeries(seriesOf(segments), limitsOf(zoneLimits));

  return {
    name: name ? textOf(name) : '',
    durationSeconds,
    segments,
    ...stats,
    intensityFactor: stats.normalizedFraction,
    approximate,
  };
}
