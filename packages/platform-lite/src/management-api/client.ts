import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './types.js';

export type ManagementApiClient = Client<paths>;

export function createManagementApiClient(
  baseUrl: string,
  accessToken: string
): ManagementApiClient {
  return createClient<paths>({
    baseUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}
