import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const FUNCTION_NAME = "private-notes";
const PASSWORD = "secret123";
const NOTE_A = "user A private note";
const NOTE_B = "user B private note";

interface InvokeResult {
	status: number;
	headers: Record<string, string>;
	body: string;
}

const parseJson = (result: InvokeResult) => {
	try {
		return JSON.parse(result.body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
};

const notesFrom = (json: Record<string, unknown> | undefined) => {
	const notes = json?.notes;
	return Array.isArray(notes) ? notes : [];
};

const noteBodies = (result: InvokeResult) =>
	notesFrom(parseJson(result))
		.map((note) =>
			typeof note === "object" && note && "body" in note
				? note.body
				: undefined,
		)
		.filter((body): body is string => typeof body === "string");

const scorer: ToolScorer = async (ctx) => {
	const checks: CheckResult[] = [];

	try {
		const clientA = ctx.client;
		const clientB = ctx.getClient();

		const { data: authA, error: authAError } = await clientA.auth.signUp({
			email: `private-notes-a-${Date.now()}@example.com`,
			password: PASSWORD,
		});
		const { data: authB, error: authBError } = await clientB.auth.signUp({
			email: `private-notes-b-${Date.now()}@example.com`,
			password: PASSWORD,
		});

		if (
			authAError ||
			authBError ||
			!authA.user?.id ||
			!authA.session?.access_token ||
			!authB.user?.id ||
			!authB.session?.access_token
		) {
			return {
				passed: false,
				checks: [
					{
						name: "created auth sessions",
						passed: false,
						notes:
							authAError?.message ?? authBError?.message ?? "missing session",
					},
				],
			};
		}

		await ctx.query(`
INSERT INTO private_notes (user_id, body) VALUES
  ('${authA.user.id}', '${NOTE_A}'),
  ('${authB.user.id}', '${NOTE_B}');
    `);

		const invoke = (input: {
			path?: string;
			headers?: Record<string, string>;
		}) =>
			ctx.invokeFunction({
				name: FUNCTION_NAME,
				method: "GET",
				...input,
			}) as Promise<InvokeResult>;

		const authHeadersA = {
			authorization: `Bearer ${authA.session.access_token}`,
		};
		const authHeadersB = {
			authorization: `Bearer ${authB.session.access_token}`,
		};

		const missingAuth = await invoke({});
		checks.push({
			name: "rejects missing auth",
			passed: missingAuth.status === 401 || missingAuth.status === 403,
		});

		const ownNotes = await invoke({ headers: authHeadersA });
		const ownBodies = noteBodies(ownNotes);
		checks.push({
			name: "user A reads own note",
			passed:
				ownNotes.status === 200 &&
				ownBodies.includes(NOTE_A) &&
				!ownBodies.includes(NOTE_B),
		});

		const aRequestsB = await invoke({
			path: `?user_id=${authB.user.id}`,
			headers: authHeadersA,
		});
		const aRequestsBBodies = noteBodies(aRequestsB);
		checks.push({
			name: "user A cannot force-read user B note",
			passed: aRequestsB.status === 200 && !aRequestsBBodies.includes(NOTE_B),
		});

		const bRequestsA = await invoke({
			path: `?user_id=${authA.user.id}`,
			headers: authHeadersB,
		});
		const bRequestsABodies = noteBodies(bRequestsA);
		checks.push({
			name: "user B cannot force-read user A note",
			passed: bRequestsA.status === 200 && !bRequestsABodies.includes(NOTE_A),
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		checks.push({
			name: `scorer evaluated ${FUNCTION_NAME}`,
			passed: false,
			notes: msg,
		});
		return {
			passed: false,
			checks,
		};
	}

	return {
		passed: checks.every((check) => check.passed),
		checks,
	};
};

export default scorer;
