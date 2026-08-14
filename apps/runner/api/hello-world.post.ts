import { start } from 'workflow/api';

import { helloWorldWorkflow } from '../workflows/hello-world.js';

export default async () => {
  const run = await start(helloWorldWorkflow);
  return Response.json({ runId: run.runId });
};
