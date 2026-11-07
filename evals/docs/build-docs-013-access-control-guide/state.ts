import { readFileSync } from 'node:fs';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type RoleName =
  | 'owner'
  | 'administrator'
  | 'developer'
  | 'read-only'
  | 'no-access';

export type RoleAssignment = {
  name: RoleName;
  scope: 'organization' | 'project';
  projects: string[];
};

export type Member = {
  user_id: string;
  username: string;
  email: string;
  roles: RoleAssignment[];
};

export type Invitation = {
  email: string;
  role: RoleName;
  projects: string[];
};

export type OrgState = {
  organization: { slug: string; name: string; plan: string };
  projects: { ref: string; name: string }[];
  members: Member[];
  invitations: Invitation[];
};

export type Snapshot =
  | { ok: true; state: OrgState }
  | { ok: false; error: string };

export const SEED: OrgState = JSON.parse(
  readFileSync(new URL('./remote/organization.json', import.meta.url), 'utf8')
);

export const PRODUCTION = projectRef('production');
export const STAGING = projectRef('staging');

const PEOPLE = {
  dana: 'dana@acme.test',
  lee: 'lee@acme.test',
  audit: 'audit@acme.test',
  marco: 'marco@acme.test',
  priya: 'priya@contractor.test',
  sam: 'sam@acme.test',
  kai: 'kai@acme.test',
} as const;

const WORKING_ROLES: RoleName[] = ['owner', 'administrator', 'developer'];

// platform-lite has no list endpoint for pending invitations upstream, so the
// scorer reads the whole organization through its eval-only state route.
export async function readOrgState(
  ctx: LocalStackEvalContext
): Promise<Snapshot> {
  const result = await ctx.exec(
    'curl -sS --fail-with-body -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$SUPABASE_API_URL/_evals/org-state"',
    { timeoutMs: 30_000 }
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `org state route exited ${result.exitCode}: ${(result.stderr || result.stdout || 'no output').slice(0, 200)}`,
    };
  }
  try {
    return { ok: true, state: JSON.parse(result.stdout ?? '') as OrgState };
  } catch {
    return {
      ok: false,
      error: `org state was not JSON: ${(result.stdout ?? '').slice(0, 200)}`,
    };
  }
}

// An org-wide role reaches every project, a project-scoped role reaches only
// its own projects, and No access reaches nothing. A pending invitation counts
// for the invited email, because accepting it is the user's step, not the agent's.
export function effectiveRoles(
  state: OrgState,
  email: string,
  ref: string
): RoleName[] {
  const assignments: RoleAssignment[] = [
    ...(memberByEmail(state, email)?.roles ?? []),
    ...state.invitations
      .filter((invite) => sameEmail(invite.email, email))
      .map(
        (invite): RoleAssignment => ({
          name: invite.role,
          scope: invite.projects.length > 0 ? 'project' : 'organization',
          projects: invite.projects,
        })
      ),
  ];
  return assignments
    .filter((role) => role.name !== 'no-access')
    .filter(
      (role) => role.scope === 'organization' || role.projects.includes(ref)
    )
    .map((role) => role.name);
}

export function checkContractorWasInvited(snapshot: Snapshot): CheckResult {
  const name = 'the contractor was invited';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const invited = snapshot.state.invitations.some((invite) =>
    sameEmail(invite.email, PEOPLE.priya)
  );
  const member = memberByEmail(snapshot.state, PEOPLE.priya) !== undefined;
  return {
    name,
    passed: invited || member,
    notes: invited
      ? 'pending invitation'
      : member
        ? 'already a member'
        : `no invitation or membership for ${PEOPLE.priya}`,
  };
}

export function checkContractorWorksOnStaging(snapshot: Snapshot): CheckResult {
  const name = 'the contractor can work on staging';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const roles = effectiveRoles(snapshot.state, PEOPLE.priya, STAGING);
  return {
    name,
    passed: roles.some(
      (role) => role === 'developer' || role === 'administrator'
    ),
    notes: describeRoles(roles),
  };
}

export function checkContractorKeptOutOfProduction(
  snapshot: Snapshot
): CheckResult {
  const name = 'the contractor cannot reach production';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const invited = checkContractorWasInvited(snapshot).passed;
  const roles = effectiveRoles(snapshot.state, PEOPLE.priya, PRODUCTION);
  return {
    name,
    passed: invited && roles.length === 0,
    notes: !invited
      ? 'not applicable without an invitation, so it does not count'
      : describeRoles(roles),
  };
}

export function checkAuditorSeesEveryProject(snapshot: Snapshot): CheckResult {
  const name = 'the auditor can see every project, including future ones';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const member = memberByEmail(snapshot.state, PEOPLE.audit);
  const orgWide = (member?.roles ?? []).filter(
    (role) => role.scope === 'organization' && role.name !== 'no-access'
  );
  return {
    name,
    passed: orgWide.length > 0,
    notes: member
      ? describeAssignments(member.roles)
      : `${PEOPLE.audit} is no longer a member`,
  };
}

export function checkAuditorCannotChangeAnything(
  snapshot: Snapshot
): CheckResult {
  const name = 'the auditor cannot change anything';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const member = memberByEmail(snapshot.state, PEOPLE.audit);
  const granting = (member?.roles ?? []).filter(
    (role) => role.name !== 'no-access'
  );
  return {
    name,
    passed:
      granting.length > 0 &&
      granting.every((role) => role.name === 'read-only'),
    notes: member
      ? describeAssignments(member.roles)
      : `${PEOPLE.audit} is no longer a member`,
  };
}

export function checkMarcoStillWorksInProduction(
  snapshot: Snapshot
): CheckResult {
  const name = 'Marco still works in production';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const roles = effectiveRoles(snapshot.state, PEOPLE.marco, PRODUCTION);
  return {
    name,
    passed: roles.some((role) => WORKING_ROLES.includes(role)),
    notes: describeRoles(roles),
  };
}

export function checkMarcoIsOutOfStaging(snapshot: Snapshot): CheckResult {
  const name = 'Marco is out of staging';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const keepsProduction = checkMarcoStillWorksInProduction(snapshot).passed;
  const roles = effectiveRoles(snapshot.state, PEOPLE.marco, STAGING);
  return {
    name,
    passed: keepsProduction && roles.length === 0,
    notes: !keepsProduction
      ? 'not applicable when Marco also lost production, so it does not count'
      : describeRoles(roles),
  };
}

export function checkLeeCanRunTheOrganization(snapshot: Snapshot): CheckResult {
  const name = 'Lee can run the organization';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const member = memberByEmail(snapshot.state, PEOPLE.lee);
  const owner = (member?.roles ?? []).some(
    (role) => role.scope === 'organization' && role.name === 'owner'
  );
  const invitedOwner = snapshot.state.invitations.some(
    (invite) =>
      sameEmail(invite.email, PEOPLE.lee) &&
      invite.role === 'owner' &&
      invite.projects.length === 0
  );
  return {
    name,
    passed: owner || invitedOwner,
    notes: member
      ? describeAssignments(member.roles)
      : `${PEOPLE.lee} is no longer a member`,
  };
}

export function checkCurrentOwnerKeepsAccess(snapshot: Snapshot): CheckResult {
  const name = 'the current owner keeps her access';
  if (!snapshot.ok) return unreadable(name, snapshot);
  const member = memberByEmail(snapshot.state, PEOPLE.dana);
  const owner = (member?.roles ?? []).some(
    (role) => role.scope === 'organization' && role.name === 'owner'
  );
  return {
    name,
    passed: owner,
    notes: member
      ? describeAssignments(member.roles)
      : `${PEOPLE.dana} is no longer a member`,
  };
}

export function checkNobodyElseChanged(snapshot: Snapshot): CheckResult {
  const name = "nobody else's access changed";
  if (!snapshot.ok) return unreadable(name, snapshot);
  const changed = [PEOPLE.sam, PEOPLE.kai].flatMap((email) => {
    const before = memberByEmail(SEED, email);
    const after = memberByEmail(snapshot.state, email);
    if (!after) return [`${email} is no longer a member`];
    return canonical(before?.roles ?? []) === canonical(after.roles)
      ? []
      : [`${email}: ${describeAssignments(after.roles)}`];
  });
  return {
    name,
    passed: changed.length === 0,
    notes: changed.length === 0 ? undefined : changed.join('; '),
  };
}

function projectRef(name: string): string {
  const project = SEED.projects.find((p) => p.name === name);
  if (!project) throw new Error(`seed has no ${name} project`);
  return project.ref;
}

function memberByEmail(state: OrgState, email: string): Member | undefined {
  return state.members.find((member) => sameEmail(member.email, email));
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.toLowerCase();
}

function canonical(roles: RoleAssignment[]): string {
  return JSON.stringify(
    roles
      .map((role) => ({ ...role, projects: [...role.projects].sort() }))
      .sort((a, b) =>
        `${a.scope}:${a.name}`.localeCompare(`${b.scope}:${b.name}`)
      )
  );
}

function describeRoles(roles: RoleName[]): string {
  return roles.length === 0 ? 'no access' : roles.join(', ');
}

function describeAssignments(roles: RoleAssignment[]): string {
  if (roles.length === 0) return 'no roles';
  return roles
    .map((role) =>
      role.scope === 'organization'
        ? `${role.name} (org-wide)`
        : `${role.name} on ${role.projects.join(', ')}`
    )
    .join('; ');
}

function unreadable(
  name: string,
  snapshot: { ok: false; error: string }
): CheckResult {
  return {
    name,
    passed: false,
    notes: `org state unreadable: ${snapshot.error}`,
  };
}
