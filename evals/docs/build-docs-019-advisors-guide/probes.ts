import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export type Run = (
  sql: string
) => Promise<{ ok: boolean; stdout: string; message: string }>;

export const PROBE_CHECK = {
  refused: 'every seeded relationship still refuses a row that points nowhere',
  booked: 'a practitioner can hold two appointments in the same room',
} as const;

const FOREIGN_KEY_VIOLATION = '23503';

export type Outcomes = {
  booked: string;
  practitionerClinic: string;
  appointmentPractitioner: string;
  appointmentRoom: string;
};

export type Probe = { outcomes: Outcomes } | { failure: string };

export async function runProbe(run: Run): Promise<Probe> {
  const marker = `adv${randomUUID().slice(0, 8)}`;
  const result = await run(probeSql(marker));
  if (!result.ok) {
    return { failure: `the probe could not run: ${result.message}` };
  }
  const line = result.stdout
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith('{'));
  if (line === undefined) {
    return { failure: 'the probe printed no result' };
  }
  const parsed = JSON.parse(line) as Partial<Outcomes> & { setup?: string };
  if (parsed.setup !== undefined) {
    return {
      failure: `could not build a clinic to book into: ${parsed.setup}`,
    };
  }
  return {
    outcomes: {
      booked: String(parsed.booked),
      practitionerClinic: String(parsed.practitionerClinic),
      appointmentPractitioner: String(parsed.appointmentPractitioner),
      appointmentRoom: String(parsed.appointmentRoom),
    },
  };
}

export function checkRelationshipsRefuseOrphans(probe: Probe): CheckResult {
  const name = PROBE_CHECK.refused;
  if ('failure' in probe) {
    return { name, passed: false, notes: `not run: ${probe.failure}` };
  }
  const { outcomes } = probe;
  const relationships: [string, string][] = [
    [
      'a practitioner at a clinic that does not exist',
      outcomes.practitionerClinic,
    ],
    [
      'an appointment with a practitioner who does not exist',
      outcomes.appointmentPractitioner,
    ],
    ['an appointment in a room another clinic owns', outcomes.appointmentRoom],
  ];
  const accepted = relationships.filter(
    ([, outcome]) => outcome !== FOREIGN_KEY_VIOLATION
  );
  return {
    name,
    passed: accepted.length === 0,
    notes:
      accepted.length === 0
        ? 'all three refused'
        : accepted
            .map(([label, outcome]) =>
              outcome === 'ok'
                ? `${label} was accepted`
                : `${label} failed with ${outcome}, not ${FOREIGN_KEY_VIOLATION}`
            )
            .join('; '),
  };
}

export function checkTwoAppointmentsBooked(probe: Probe): CheckResult {
  const name = PROBE_CHECK.booked;
  if ('failure' in probe) {
    return { name, passed: false, notes: `not run: ${probe.failure}` };
  }
  const { booked } = probe.outcomes;
  return {
    name,
    passed: booked === 'ok',
    notes:
      booked === 'ok'
        ? 'both appointments booked'
        : `booking two appointments failed with ${booked}`,
  };
}

function probeSql(marker: string): string {
  return stripIndent`
    begin;

    create function pg_temp.attempt(statement text) returns text
    language plpgsql as $attempt$
    begin
      execute statement;
      return 'ok';
    exception when others then
      return sqlstate;
    end
    $attempt$;

    create function pg_temp.probe(marker text) returns jsonb
    language plpgsql as $probe$
    declare
      home bigint;
      elsewhere bigint;
      practitioner bigint;
      book text := 'insert into public.appointments (clinic_id, room_code, practitioner_id, starts_at) values (%s, %L, %s, %L)';
    begin
      insert into public.clinics (name) values (marker || '-home') returning id into home;
      insert into public.clinics (name) values (marker || '-elsewhere') returning id into elsewhere;
      insert into public.rooms (clinic_id, code) values (home, marker);
      insert into public.practitioners (clinic_id, name) values (home, marker) returning id into practitioner;
      return jsonb_build_object(
        'booked', pg_temp.attempt(
          format(book, home, marker, practitioner, '2030-01-07 09:00+00')
          || format(', (%s, %L, %s, %L)', home, marker, practitioner, '2030-01-07 10:00+00')
        ),
        'practitionerClinic', pg_temp.attempt(format(
          'insert into public.practitioners (clinic_id, name) values (%s, %L)',
          -1, marker || '-nowhere'
        )),
        'appointmentPractitioner', pg_temp.attempt(
          format(book, home, marker, -1, '2030-01-07 11:00+00')
        ),
        'appointmentRoom', pg_temp.attempt(
          format(book, elsewhere, marker, practitioner, '2030-01-07 12:00+00')
        )
      );
    exception when others then
      return jsonb_build_object('setup', sqlstate || ' ' || sqlerrm);
    end
    $probe$;

    select pg_temp.probe('${marker}');

    rollback;
  `;
}
