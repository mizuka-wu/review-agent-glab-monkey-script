import { anchorFindings } from './anchor';
import { buildReviewContext, fileOmissionReason, includedFiles } from './context';
import { fullFileContext, loadFullFiles, mergeFullFiles, type FullFileLoader } from './full-file';
import { normalizeFindings, parseModelFindings } from './findings';
import { runRuleReview } from './rules';
import type {
  CodeSelection,
  FileDiff,
  Finding,
  FullFileOmission,
  FullFileSnapshot,
  ReviewContext,
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

function fullFileEligible(path: string) {
  return !fileOmissionReason({
    oldPath: path,
    newPath: path,
    diff: '',
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: [],
  });
}

function mergeContextFiles(context: ReviewContext, snapshots: FullFileSnapshot[]): ReviewContext['files'] {
  const byPath = new Map(snapshots.map((file) => [file.path, file.content]));
  return context.files.map((file) => {
    const content = byPath.get(file.newPath) ?? byPath.get(file.oldPath);
    return content ? { ...file, newFileContent: content } : file;
  });
}

function withFullFiles(
  context: ReviewContext,
  snapshots: FullFileSnapshot[],
  omitted: FullFileOmission[],
): ReviewContext {
  const files = mergeContextFiles(context, snapshots);
  const estimatedCharacters = context.estimatedCharacters + files.reduce(
    (total, file) => total + (file.included ? fullFileContext(file).length : 0),
    0,
  );
  return {
    ...context,
    files,
    estimatedCharacters,
    fullFiles: snapshots,
    omittedFullFiles: omitted,
  };
}

export function buildSelectionContext(selection: CodeSelection) {
  return buildReviewContext({ files: [selectionFileFor(selection)], selection });
}

function selectionFileFor(selection: CodeSelection): FileDiff {
  const lines = selection.text.split('\n');
  return {
    oldPath: selection.filePath,
    newPath: selection.filePath,
    diff: lines.map((line) => `+${line}`).join('\n'),
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: lines.map((text, index) => ({
      hunkId: 'selection',
      newLine: selection.startLine + index,
      kind: 'added',
      text,
    })),
  };
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
    loadFile?: FullFileLoader;
    fullFileRef?: string;
    candidatePaths?: string[];
  }): Promise<ReviewEngineResult> {
    const baseContext = buildReviewContext(input);
    const diffFiles = includedFiles(baseContext);
    let fullFiles: FullFileSnapshot[] = [];
    let omittedFullFiles: FullFileOmission[] = [];

    if (this.runtime.configured && input.loadFile && input.fullFileRef) {
      const paths = [...new Set([
        ...diffFiles.filter((file) => !file.deletedFile).map((file) => file.newPath),
        ...(input.candidatePaths ?? []),
      ])].filter(fullFileEligible);
      const loaded = await loadFullFiles(paths, input.fullFileRef, input.loadFile, {}, input.signal);
      fullFiles = loaded.files;
      omittedFullFiles = loaded.omitted;
    }

    const context = withFullFiles(baseContext, fullFiles, omittedFullFiles);
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

      if (input.loadFile && input.fullFileRef) {
        const knownPaths = new Set(fullFiles.map((file) => file.path));
        const candidatePaths = [...new Set(findings.flatMap((finding) => [
          finding.path,
          ...finding.evidence.map((evidence) => evidence.path),
        ]))]
          .filter((path) => !knownPaths.has(path))
          .filter(fullFileEligible);
        const additional = await loadFullFiles(candidatePaths, input.fullFileRef, input.loadFile, {}, input.signal);
        fullFiles = mergeFullFiles(fullFiles, additional.files);
        omittedFullFiles = [...omittedFullFiles, ...additional.omitted];
      }
    } else {
      source = 'rule';
      findings = normalizeFindings(runRuleReview(files), files);
    }

    findings = anchorFindings(findings, files, fullFiles);
    if (this.settings.effort === 'fast') {
      findings = findings.filter((finding) => finding.confidence !== 'low');
    }

    const relocated = findings.filter((finding) => finding.anchor?.relocatedFromPath).length;
    const fullFileAnchored = findings.filter((finding) => finding.anchor?.source === 'full-file').length;
    if (relocated > 0) warnings.push(`${relocated} 个 Finding 已按 existingCode 跨文件重定位。`);
    if (fullFileAnchored > 0) warnings.push(`${fullFileAnchored} 个 Finding 仅锚定到完整文件，不能发布为行级 Discussion。`);
    if (omittedFullFiles.length > 0) warnings.push(`完整文件读取省略 ${omittedFullFiles.length} 个文件。`);

    return {
      findings: dedupe(findings).sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
      context: { ...context, fullFiles, omittedFullFiles },
      source,
      warnings,
    };
  }
}
