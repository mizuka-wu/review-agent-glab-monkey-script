import { BUILT_IN_PACK, runRulePackReview } from './rule-packs';
import type { Finding, FileDiff } from './types';

export function runRuleReview(files: FileDiff[]): Finding[] {
  return runRulePackReview(files, [BUILT_IN_PACK]);
}
