import { anchorFindings } from './anchor';
import { buildReviewContext, fileOmissionReason, includedFiles } from './context';
import { fullFileContext, loadFullFiles, mergeFullFiles, type FullFileLoader } from './full-file';
import { parseModelFindings } from './findings';
import { corroborateFindings, hardenFindings } from './finding-hardening';
import { BUILT_IN_PACK, countEnabledRules, runRulePackReview, type RulePack } from './rule-packs';
import type {
  CodeSelection,
  FileDiff,
  Finding,
  FindingSource,
  FullFileOmission,
  FullFileSnapshot,
  ReviewContext,
  ReviewEngineResult,
  RuntimeSettings,
} from './types';

interface ReviewRuntime {
  configured: boolean;
  review(files: FileDiff[], selection: CodeSelection | undefined, language: RuntimeSettings['language'], signal?: AbortSignal, background?: string, options?: { onToken?: (token: string) => void }): Promise<string>;
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
    const key = `${finding.path}:${finding.line}:${finding.category}:${finding.title.toLowerCase()}:${finding.existingCode.slice(0, 50)}`;
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

export class ReviewEngine {
  constructor(
    private readonly runtime: ReviewRuntime,
    private readonly settings: RuntimeSettings,
    private readonly rulePacks: RulePack[] = [BUILT_IN_PACK],
  ) {}

  async run(input: {
    files: FileDiff[];
    selection?: CodeSelection;
    background?: string;
    signal?: AbortSignal;
    loadFile?: FullFileLoader;
    fullFileRef?: string;
    candidatePaths?: string[];
    /** 关闭后只跑 AI 评审。默认开启，未配置模型时也能独立工作。 */
    rules?: boolean;
    /** 规则阶段完成后立即回调，用于增量渲染结果。 */
    onRuleFindings?: (findings: Finding[]) => void;
    /** 模型流式输出回调，用于实时展示 AI 正在工作。 */
    onModelToken?: (token: string) => void;
    /** 关闭后只跑规则检查，即使模型已配置。 */
    model?: boolean;
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

    // 阶段一：确定性规则检查。不依赖模型，未配置 API Key 时同样运行。
    const rulePacksEnabled = input.rules !== false;
    // 规则结果已经是结构化 Finding，保留原始换行和规则溯源信息，不再二次归一化。
    const ruleFindings = rulePacksEnabled ? runRulePackReview(files, this.rulePacks) : [];
    input.onRuleFindings?.(ruleFindings);
    const stages: ReviewEngineResult['stages'] = {
      rules: { ran: rulePacksEnabled, findings: ruleFindings.length, rules: rulePacksEnabled ? countEnabledRules(this.rulePacks) : 0 },
      model: { ran: false, findings: 0 },
    };
    if (rulePacksEnabled && stages.rules.rules === 0) {
      warnings.push('没有启用的规则，已跳过规则检查。可在设置中开启内置规则包。');
    }

    // 阶段二：AI 评审。模型失败不拖垮规则结果。
    let modelFindings: Finding[] = [];
    if (this.runtime.configured && input.model !== false) {
      stages.model.ran = true;
      try {
        const raw = await this.runtime.review(files, input.selection, this.settings.language, input.signal, input.background, { onToken: input.onModelToken });
        modelFindings = parseModelFindings(raw, files);
        stages.model.findings = modelFindings.length;

        if (input.loadFile && input.fullFileRef) {
          const knownPaths = new Set(fullFiles.map((file) => file.path));
          const candidatePaths = [...new Set(modelFindings.flatMap((finding) => [
            finding.path,
            ...finding.evidence.map((evidence) => evidence.path),
          ]))]
            .filter((path) => !knownPaths.has(path))
            .filter(fullFileEligible);
          const additional = await loadFullFiles(candidatePaths, input.fullFileRef, input.loadFile, {}, input.signal);
          fullFiles = mergeFullFiles(fullFiles, additional.files);
          omittedFullFiles = [...omittedFullFiles, ...additional.omitted];
        }
      } catch (error) {
        if (input.signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
        stages.model.error = error instanceof Error ? error.message : String(error);
        stages.model.ran = false;
        warnings.push(`AI 评审未产出结果：${stages.model.error}。已保留规则检查结果。`);
      }
    } else if (rulePacksEnabled) {
      warnings.push(input.model === false
        ? '当前为「仅规则」模式，已跳过 AI 评审。'
        : `未配置模型，本次仅执行 ${stages.rules.rules} 条确定性规则检查；配置 API Key 后可叠加 AI 深度评审。`);
    }

    const context2: ReviewContext = { ...context, fullFiles, omittedFullFiles };
    const combined = corroborateFindings(ruleFindings, modelFindings);
    const corroborated = combined.filter((finding) => finding.corroborated).length;
    if (corroborated > 0) warnings.push(`${corroborated} 个问题被规则和 AI 同时命中，已合并并标注。`);
    let findings = anchorFindings(combined, files, fullFiles);

    const hardened = hardenFindings(findings, files, this.settings.effort);
    findings = hardened.findings;

    if (hardened.merged > 0) warnings.push(`合并了 ${hardened.merged} 个相似 Finding。`);
    if (hardened.severityAdjusted > 0) warnings.push(`校准了 ${hardened.severityAdjusted} 个 AI Finding 的严重度。`);
    if (hardened.filtered > 0) warnings.push(`按证据充分度或审查强度过滤了 ${hardened.filtered} 个 Finding。`);

    const relocated = findings.filter((finding) => finding.anchor?.relocatedFromPath).length;
    const fullFileAnchored = findings.filter((finding) => finding.anchor?.source === 'full-file').length;
    if (relocated > 0) warnings.push(`${relocated} 个 Finding 已按 existingCode 跨文件重定位。`);
    if (fullFileAnchored > 0) warnings.push(`${fullFileAnchored} 个 Finding 仅锚定到完整文件，不能发布为行级 Discussion。`);
    if (omittedFullFiles.length > 0) warnings.push(`完整文件读取省略 ${omittedFullFiles.length} 个文件。`);

    const finalFindings = dedupe(findings).sort(compareFindings);
    const sources = ([...new Set(finalFindings.flatMap(
      (finding) => finding.corroborated ? [finding.source, finding.corroborated] : [finding.source],
    ))] as FindingSource[])
      .sort((left, right) => (left === 'rule' ? -1 : 1) - (right === 'rule' ? -1 : 1));
    stages.rules.findings = finalFindings.filter((finding) => finding.source === 'rule').length;
    stages.model.findings = finalFindings.filter((finding) => finding.source === 'model').length;

    return {
      findings: finalFindings,
      context: context2,
      source: stages.model.findings > 0 ? 'model' : 'rule',
      sources,
      stages,
      warnings,
    };
  }
}

function compareFindings(left: Finding, right: Finding) {
  if (severityOrder[left.severity] !== severityOrder[right.severity]) {
    return severityOrder[left.severity] - severityOrder[right.severity];
  }
  if (left.source !== right.source) return left.source === 'rule' ? -1 : 1;
  if (left.path !== right.path) return left.path.localeCompare(right.path);
  return left.line - right.line;
}
