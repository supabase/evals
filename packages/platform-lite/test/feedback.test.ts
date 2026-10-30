import { describe, expect, it } from 'vitest';
import { createPlatform } from '../src/app.js';

// Same calls the MCP server makes, without the management access token.
describe('feedback project', () => {
  it('deletes feedback only for the project it was submitted from', async () => {
    await using platform = await createPlatform({ accessToken: 'test-token' });
    const submit = await platform.app.request(
      '/feedback/rest/v1/rpc/submit_interfaces_feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'hi', project_ref: 'proj' }),
      }
    );
    expect(submit.status).toBe(200);
    const token: string = await submit.json();

    const remove = (projectRef: string) =>
      platform.app.request(
        `/feedback/rest/v1/interfaces_feedback?delete_token=eq.${token}`,
        {
          method: 'DELETE',
          headers: {
            Prefer: 'count=exact',
            'x-feedback-token': token,
            'x-feedback-project-ref': projectRef,
          },
        }
      );

    expect((await remove('other')).headers.get('Content-Range')).toBe('*/0');
    expect((await remove('proj')).headers.get('Content-Range')).toBe('*/1');
    expect((await remove('proj')).headers.get('Content-Range')).toBe('*/0');
  });

  it('finishes accepted requests before closing, then refuses new ones', async () => {
    const platform = await createPlatform();
    const submit = () =>
      platform.app.request('/feedback/rest/v1/rpc/submit_interfaces_feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'hi' }),
      });

    const accepted = submit();
    await platform.dispose();

    expect((await accepted).status).toBe(200);
    expect((await submit()).status).toBe(503);
  });
});
