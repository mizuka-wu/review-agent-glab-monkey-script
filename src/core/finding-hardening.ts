import type { Finding, FindingConfidence, FindingSeverity, FileDiff } from './types';

// --- Evidence sufficiency ---

export interface EvidenceCheck {
  finding: Finding;
  score: number;
  issues: string[];
  passed: boolean;
}

/**
 * Check whether a finding has sufficient evidence to be actionable.
 * Returns a score 0-1 and list of issues.
 */
export function checkEvidenceSufficiency(finding: Finding, files: FileDiff[]): EvidenceCheck {
  const issues: string[] = [];
  let score = 1.0;

  // 1. existingCode must be non-empty and matchable
  if (!finding.existingCode || finding.existingCode.trim().length === 0) {
    issues.push('缺少 existingCode 锚点');
    score -= 0.4;
  } else if (finding.existingCode.trim().length < 5) {
    issues.push('existingCode 过短，可能无法唯一定位');
    score -= 0.15;
  }

  // 2. Must have evidence
  if (finding.evidence.length === 0) {
    issues.push('缺少证据引用');
    score -= 0.3;
  }

  // 3. Title and content must be substantive
  if (finding.title.length < 5) {
    issues.push('标题过短');
    score -= 0.1;
  }
  if (finding.content.length < 15) {
    issues.push('说明内容过短');
    score -= 0.15;
  }

  // 4. For bugs and security, require more evidence
  if ((finding.category === 'bug' || finding.category === 'security') && finding.evidence.length < 1) {
    issues.push(`${finding.category} 类问题需要至少一条证据`);
    score -= 0.25;
  }

  // 5. Check if the finding's file is in the diff
  const fileExists = files.some(
    (f) => f.newPath === finding.path || f.oldPath === finding.path,
  );
  if (!fileExists) {
    issues.push('目标文件不在 Diff 中');
    score -= 0.2;
  }

  return {
    finding,
    score: Math.max(0, score),
    issues,
    passed: score >= 0.5,
  };
}

// --- Severity calibration ---

export function calibrateSeverity(finding: Finding): Finding {
  let severity = finding.severity;

  // Security findings default to at least medium
  if (finding.category === 'security' && severity === 'low') {
    severity = 'medium';
  }

  // Empty catch / weak types should not be high severity
  if (finding.category === 'maintainability' && (severity === 'critical' || severity === 'high')) {
    severity = 'medium';
  }

  // Missing test should not be high severity
  if (finding.category === 'test' && (severity === 'critical' || severity === 'high')) {
    severity = 'medium';
  }

  // If evidence is thin, cap severity
  if (finding.evidence.length === 0 && (severity === 'critical' || severity === 'high')) {
    severity = 'medium';
  }

  return severity === finding.severity ? finding : { ...finding, severity };
}

// --- Similar finding merge ---

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
}

function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeTitle(a).split(/\s+/));
  const tokensB = new Set(normalizeTitle(b).split(/\s+/));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

/**
 * Merge findings that are similar in title and same path+line.
 * Keeps the one with higher confidence and longer content.
 */
export function mergeSimilarFindings(findings: Finding[]): Finding[] {
  const result: Finding[] = [];
  const used = new Set<number>();

  for (let i = 0; i < findings.length; i += 1) {
    if (used.has(i)) continue;
    let best = findings[i];

    for (let j = i + 1; j < findings.length; j += 1) {
      if (used.has(j)) continue;
      const candidate = findings[j];

      // Must be on same file and line
      if (candidate.path !== best.path) continue;
      if (candidate.line !== best.line && candidate.endLine !== best.endLine) continue;

      // Check title similarity
      const similarity = titleSimilarity(best.title, candidate.title);
      if (similarity < 0.6) continue;

      // Merge: keep the one with more content
      if (candidate.content.length > best.content.length) {
        best = candidate;
      }
      used.add(j);
    }

    result.push(best);
    used.add(i);
  }

  return result;
}

// --- Confidence adjustment based on effort ---

export function applyEffortBudget(findings: Finding[], effort: 'fast' | 'balanced' | 'thorough'): Finding[] {
  switch (effort) {
    case 'fast':
      // Only high confidence, high/critical severity
      return findings.filter(
        (f) => f.confidence === 'high' && (f.severity === 'high' || f.severity === 'critical'),
      );
    case 'thorough':
      // Keep everything
      return findings;
    case 'balanced':
    default:
      // Keep medium+ confidence
      return findings.filter((f) => f.confidence !== 'low');
  }
}

// --- Full hardening pipeline ---

export interface HardeningResult {
  findings: Finding[];
  evidenceChecks: EvidenceCheck[];
  merged: number;
  severityAdjusted: number;
  filtered: number;
}

export function hardenFindings(
  findings: Finding[],
  files: FileDiff[],
  effort: 'fast' | 'balanced' | 'thorough',
): HardeningResult {
  const total = findings.length;

  // 1. Calibrate severity
  let severityAdjusted = 0;
  const calibrated = findings.map((f) => {
    const result = calibrateSeverity(f);
    if (result.severity !== f.severity) severityAdjusted += 1;
    return result;
  });

  // 2. Check evidence
  const evidenceChecks = calibrated.map((f) => checkEvidenceSufficiency(f, files));
  const withEvidence = calibrated.filter((_, i) => evidenceChecks[i].passed);

  // 3. Merge similar
  const merged = mergeSimilarFindings(withEvidence);
  const mergeCount = withEvidence.length - merged.length;

  // 4. Apply effort budget
  const budgeted = applyEffortBudget(merged, effort);
  const filtered = merged.length - budgeted.length;

  return {
    findings: budgeted,
    evidenceChecks,
    merged: mergeCount,
    severityAdjusted,
    filtered: filtered + (calibrated.length - withEvidence.length),
  };
}
