import { Sandbox } from '@vercel/sandbox';

export default async () => {
  const deleted: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const sandboxes = await Sandbox.list();

  for await (const sandbox of sandboxes) {
    if (sandbox.status !== 'stopped') continue;

    try {
      const handle = await Sandbox.get({ name: sandbox.name, resume: false });
      await handle.delete();
      deleted.push(sandbox.name);
    } catch (error) {
      failed.push({
        name: sandbox.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json(
    { deleted, failed },
    { status: failed.length === 0 ? 200 : 500 }
  );
};
