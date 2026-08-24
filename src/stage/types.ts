export const STAGE_CATEGORIES = ["Contract", "Code", "Tests", "Test fixtures", "Docs", "Generated"] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];
export const STAGE_SIGNALS = ["low", "medium", "high"] as const;
export type StageSignal = (typeof STAGE_SIGNALS)[number];

export interface StageExample {
  code: string;
  text: string;
}

export type StageMember =
  | { type: "change"; id: string; description: string }
  | { type: "material"; id: string; description: string }
  | { type: "file"; id: string; description: string };

export interface StageGroup {
  id: string;
  title: string;
  category: StageCategory;
  importance: StageSignal;
  complexity: StageSignal;
  explanation: string;
  attention?: string;
  examples: StageExample[];
  members: StageMember[];
}

export interface StageDoc {
  identity: {
    id: string;
    slug: string;
    version: number;
    title: string;
    createdAt: string;
  };
  source: {
    captureId: string;
    repo: string;
    repoId: number;
    branch: string;
    baseRef: string;
    sourceHeadSha: string;
    baseTipSha: string;
    mergeBaseSha: string;
  };
  builder: {
    intent: string;
    context: string;
    agent: { name: string; model: string };
    userId: string;
    keyId: string;
  };
  witness: {
    summary: string;
    groups: StageGroup[];
    agent: { name: string; model: string };
    userId: string;
    keyId: string;
  };
  projects: string[];
}
