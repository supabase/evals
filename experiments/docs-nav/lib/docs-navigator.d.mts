export interface NavigatorReply {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

export interface NavigatorFetchResponse {
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
}

export declare function createNavigator(options: {
  env: Record<string, string | undefined>;
  fetch: (
    url: string,
    init?: { signal?: AbortSignal }
  ) => Promise<NavigatorFetchResponse>;
}): {
  root: string;
  tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  openPage(url: unknown): Promise<NavigatorReply>;
};
