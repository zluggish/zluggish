import { t } from '#src/i18n/index';
import { XMLParser } from 'fast-xml-parser';
import { Schema } from 'effect';

export const mapChoices = [
  { value: '7', key: 'LONDON', label: t('london_yorkshire') },
  { value: '13', key: 'MAKURIISLANDS', label: t('makuri_islands_new_york') },
  { value: '14', key: 'FRANCE', label: t('france_paris') },
  { value: '2', key: 'RICHMOND', label: t('richmond_london') },
  { value: '9', key: 'INNSBRUCK', label: t('innsbruck_richmond') },
  { value: '17', key: 'SCOTLAND', label: t('scotland_makuri_islands') },
];

const appointment = Schema.Struct({
  start: Schema.String,
  map: Schema.optional(Schema.String),
  road: Schema.optional(Schema.String),
  world: Schema.optional(Schema.String),
  portal: Schema.optional(Schema.String),
});

const appointments = Schema.Struct({ appointments: Schema.Struct({ appointment: Schema.Array(appointment) }) });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  isArray: (name) => name === 'appointment',
});

// Schedule timestamps use an hour-only offset, which Date.parse does not accept.
function startTime(start: string) {
  return Date.parse(start.replace(/([+-]\d{2})$/, '$1:00'));
}

export function calendarLabels(
  mapXml: string,
  climbXml: string,
  climbs: ReadonlyArray<{ road: string; name: string }>,
  now = Date.now(),
) {
  const maps = Schema.decodeUnknownSync(Schema.Struct({ MapSchedule: appointments }))(parser.parse(mapXml)).MapSchedule
    .appointments.appointment;

  const roads = Schema.decodeUnknownSync(
    Schema.Struct({ PortalRoads: Schema.Struct({ PortalRoadSchedule: appointments }) }),
  )(parser.parse(climbXml)).PortalRoads.PortalRoadSchedule.appointments.appointment;

  const activeMap = maps
    .filter((entry) => startTime(entry.start) <= now)
    .sort((a, b) => startTime(b.start) - startTime(a.start))[0];

  const activeRoads = new Map<string, (typeof appointment)['Type']>();

  for (const entry of roads) {
    if (startTime(entry.start) > now || !Number.isFinite(startTime(entry.start))) {
      continue;
    }
    const key = `${entry.world ?? ''}:${entry.portal ?? ''}`;
    const previous = activeRoads.get(key);

    if (!previous || startTime(entry.start) > startTime(previous.start)) {
      activeRoads.set(key, entry);
    }
  }

  const map = mapChoices.find((choice) => choice.key === activeMap?.map)?.label;

  const climb = activeRoads
    .values()
    .map((entry) => climbs.find((choice) => choice.road === entry.road)?.name)
    .filter((name) => name !== undefined)
    .toArray()
    .join(' / ');

  return {
    map: map ? `${map} (Calendar)` : t('calendar'),
    climb: climb ? `${climb} (Calendar)` : t('calendar'),
  };
}
