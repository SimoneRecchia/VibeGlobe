// The feature list schema (ADR 0003) and its loader, shared by the status and integrity scripts.
import { readFileSync } from 'node:fs';

type FeatureStatus = 'passing' | 'failing';

export interface Feature {
  id: string;
  milestone: number;
  section: string;
  description: string;
  steps: string[];
  status: FeatureStatus;
}

export interface FeatureList {
  milestones: Record<string, string>;
  features: Feature[];
}

const FEATURE_LIST_URL = new URL('../feature_list.json', import.meta.url);

export function parseFeatureList(json: string): FeatureList {
  return JSON.parse(json) as FeatureList;
}

export function loadFeatureList(url: URL = FEATURE_LIST_URL): FeatureList {
  return parseFeatureList(readFileSync(url, 'utf8'));
}
