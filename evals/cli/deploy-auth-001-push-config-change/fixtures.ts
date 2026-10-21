import { readFileSync } from 'node:fs';
import type {
  CommandResult,
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
} from '@supabase-evals/core';
import { vi } from 'vitest';
import { type HostedFacts, NO_HOSTED_PROJECT } from '../lib/hosted.js';

export type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export const HOSTED_REF = 'abcdefghijklmnopqrst';
export const FAKE_ACCESS_TOKEN = `sbp_${'e'.repeat(40)}`;
export const AUTH_CONFIG_PATH = '/v1/projects/{ref}/config/auth';
export const READ_CONFIG_COMMAND = 'cat supabase/config.toml';

export const SEED_CONFIG = readFileSync(
  new URL('./local/supabase/config.toml', import.meta.url),
  'utf8'
);

/** The seed with its `minimum_password_length = 6` line holding `tomlValue`, written as raw TOML. */
export const seedWith = (tomlValue: string | number) =>
  SEED_CONFIG.replace(
    'minimum_password_length = 6',
    `minimum_password_length = ${tomlValue}`
  );

/** The [auth] block `supabase init` writes, with a decoy `= 10` on another key and sub-tables that must not be read as [auth]. */
export const initTemplateWith = (
  minPasswordLength: number
) => `project_id = "orders-app"

[db]
major_version = 17

[auth]
enabled = true
# The base URL of your website. Used as an allow-list for redirects and for constructing URLs used
# in emails.
site_url = "http://127.0.0.1:3000"
# A list of *exact* URLs that auth providers are permitted to redirect to post authentication.
additional_redirect_urls = ["https://127.0.0.1:3000"]
# How long tokens are valid for, in seconds. Defaults to 3600 (1 hour), maximum 604,800 (1 week).
jwt_expiry = 3600
# If disabled, the refresh token will never expire.
enable_refresh_token_rotation = true
# Allows refresh tokens to be reused after expiry, up to the specified interval in seconds.
# Requires enable_refresh_token_rotation = true.
refresh_token_reuse_interval = 10
# Allow/disallow new user signups to your project.
enable_signup = true
# Allow/disallow anonymous sign-ins to your project.
enable_anonymous_sign_ins = false
# Allow/disallow testing manual linking of accounts
enable_manual_linking = false
# Passwords shorter than this value will be rejected as weak. Minimum 6, recommended 8 or more.
minimum_password_length = ${minPasswordLength}
# Passwords that do not meet the following requirements will be rejected as weak. Supported values
# are: \`letters_digits\`, \`lower_upper_letters_digits\`, \`lower_upper_letters_digits_symbols\`
password_requirements = ""

[auth.rate_limit]
# Number of emails that can be sent per hour. Requires auth.email.smtp to be enabled.
email_sent = 2
# Number of SMS messages that can be sent per hour. Requires auth.sms to be enabled.
sms_sent = 30
# Number of anonymous sign-ins that can be made per hour per IP address. Requires enable_anonymous_sign_ins = true.
anonymous_users = 30
# Number of sessions that can be refreshed in a 5 minute interval per IP address.
token_refresh = 150

[auth.email]
# Allow/disallow new user signups via email to your project.
enable_signup = true
# If enabled, a user will be required to confirm any email change on both the old, and new email
# addresses. If disabled, only the new email is required to confirm.
double_confirm_changes = true
# If enabled, users need to confirm their email address before signing in.
enable_confirmations = false
# If enabled, users will need to reauthenticate or have logged in recently to change their password.
secure_password_change = false
# Controls the minimum amount of time that must pass before sending another signup confirmation or password reset email.
max_frequency = "1s"
# Number of characters used in the email OTP.
otp_length = 6
# Number of seconds before the email OTP expires (defaults to 1 hour).
otp_expiry = 3600
`;

export const HOSTED_OK: HostedFacts = { ok: true, ref: HOSTED_REF };

export const HOSTED_ABSENT: HostedFacts = {
  ok: false,
  notes: NO_HOSTED_PROJECT,
};

export function commandResult(stdout = ''): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

export function failure(exitCode: number, output = ''): CommandResult {
  return { ok: false, exitCode, stdout: output, stderr: '' };
}

export function stderrFailure(exitCode: number, stderr: string): CommandResult {
  return { ok: false, exitCode, stdout: '', stderr };
}

export const MISSING_CONFIG = stderrFailure(
  1,
  'cat: supabase/config.toml: No such file or directory'
);

export const crash = (message = 'sandbox gone') => {
  return (): CommandResult => {
    throw new Error(message);
  };
};

type Respond = CommandResult | (() => CommandResult);
export type Route = [match: string | RegExp, respond: Respond];

/** Answers each command with the first route whose matcher it satisfies, so a prepended route overrides a later one. */
export function fakeExec(
  routes: readonly Route[],
  fallback: CommandResult = failure(127, 'command not found')
) {
  const calls: string[] = [];
  const exec: ExecCtx['exec'] = async (command) => {
    calls.push(command);
    const route = routes.find(([match]) =>
      typeof match === 'string' ? command.includes(match) : match.test(command)
    );
    if (route === undefined) return fallback;
    const [, respond] = route;
    return typeof respond === 'function' ? respond() : respond;
  };
  return { ctx: { exec } as ExecCtx, calls };
}

export const readConfigRoute = (respond: Respond): Route => [
  READ_CONFIG_COMMAND,
  respond,
];

export const configFileRoute = (text: string): Route =>
  readConfigRoute(commandResult(text));

export const versionRoute = (respond: Respond): Route => [
  /supabase --version$/,
  respond,
];

export function shellCall(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}

export type GetResult = {
  data?: unknown;
  error?: unknown;
  response: { status: number };
};

export const authConfig = (passwordMinLength: number | null): GetResult => ({
  data: {
    password_min_length: passwordMinLength,
    jwt_exp: 3600,
    site_url: 'http://localhost:3000',
  },
  error: undefined,
  response: { status: 200 },
});

export const apiError = (status: number, message: string): GetResult => ({
  data: undefined,
  error: { message },
  response: { status },
});

type MgmtResponse = GetResult | (() => GetResult | Promise<GetResult>);

/** A Management API client whose GET resolves to `respond`; a function `respond` may throw or reject. */
export function fakeMgmt(respond: MgmtResponse) {
  const GET = vi.fn((_path: string, _options?: unknown) =>
    typeof respond === 'function' ? respond() : Promise.resolve(respond)
  );
  return { GET, mgmt: { GET } as unknown as ManagementApiClient };
}
