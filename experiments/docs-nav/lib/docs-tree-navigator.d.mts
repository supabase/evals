export declare const ROOT: string;
export declare const OPEN_TOOL: string;
export declare const CHOOSE_TOOL: string;

export interface TreeNode {
  label: string;
  route?: string;
  description?: string;
  children?: TreeNode[];
}

export interface TreeReply {
  isError?: boolean;
  text: string;
}

export declare function treeUrl(
  env: Record<string, string | undefined>
): string;

export declare function createTreeSession(
  tree: { name: string; root: TreeNode },
  url: string
): {
  open(id: unknown): TreeReply;
  choose(id: unknown): TreeReply;
};
