import { anchorFindings } from './anchor';
import { buildReviewContext, includedFiles, selectionFile } from './context';
import { normalizeFindings, parseModelFindings } from './findings';
import { runRuleReview } from './rules';
import type {
  CodeSelection,
  FileDiff,
  Finding,
  ReviewEngineResult,
  RuntimeSettings,
} from './types';

interface ReviewRuntime {
  configured: boolean;
  review(files: FileDiff[], selection: CodeSelection | undefined, language: RuntimeSettings['language'], signal?: AbortSignal, background?: string): Promise<string>;
}

const severityOrder: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function dedupe(findings: Finding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}:${finding.line}:${finding.category}:${finding.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildSelectionContext(selection: CodeSelection) {
  return buildReviewContext({ files: [selectionFile(selection)], selection });
}

export class ReviewEngine {
  constructor(
    private readonly runtime: ReviewRuntime,
    private readonly settings: RuntimeSettings,
  ) {}

  async run(input: {
    files: FileDiff[];
    selection?: CodeSelection;
    background?: string;
    signal?: AbortSignal;
  }): Promise<ReviewEngineResult> {
    const context = buildReviewContext(input);
    const files = includedFiles(context);
    const warnings = context.omittedFiles.length > 0
      ? [`省略 ${context.omittedFiles.length} 个文件：${context.omittedFiles.map((item) => `${item.path} (${item.reason})`).join(', ')}`]
      : [];

    let findings: Finding[];
    let source: ReviewEngineResult['source'];
    if (this.runtime.configured) {
      source = 'model';
      const raw = await this.runtime.review(files, input.selection, this.settings.language, input.signal, input.background);
      findings = parseModelFindings(raw, files);
    } else {
      source = 'rule';
      findings = normalizeFindings(runRuleReview(files), files);
    }

    findings = anchorFindings(findings, files);
    if (this.settings.effort === 'fast') {
      findings = findings.filter((finding) => finding.confidence !== 'low');
    }

    return {
      findings: dedupe(findings).sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
      context,
      source,
      warnings,
    };
  }
}
