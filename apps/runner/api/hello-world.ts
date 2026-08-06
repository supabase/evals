import { start } from 'workflow/api';
import { helloWorldWorkflow } from '../workflows/hello-world.js';

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const run = await start(helloWorldWorkflow);
    return Response.json({ runId: run.runId });
  },
};
