import { runRulePackReview, BUILT_IN_PACK } from '../../src/core/rule-packs';
import type { Finding } from '../../src/core/types';
import {
  evalFixtures,
  type BenchmarkSummary,
  type EvalFixture,
  type EvalExpectedFinding,
  type FixtureResult,
} from './fixtures';

/**
 * Match a finding against an expected finding.
 */
function matchesExpected(finding: Finding, expected: EvalExpectedFinding): boolean {
  if (finding.category !== expected.category) return false;
  if (!finding.title.includes(expected.titleContains)) return false;
  if (expected.path && finding.path !== expected.path) return false;
  if (expected.lineRange) {
    const [min, max] = expected.lineRange;
    if (finding.line < min || finding.line > max) return false;
  }
  return true;
}

/**
 * Run benchmark for a single fixture.
 */
export function evaluateFixture(fixture: EvalFixture): FixtureResult {
  const findings = runRulePackReview(fixture.files, [BUILT_IN_PACK]);

  // Match expected findings
  const matchedIndices = new Set<number>();
  const missed: string[] = [];

  for (const expected of fixture.expectedFindings) {
    const found = findings.find((f, i) => {
      if (matchedIndices.has(i)) return false;
      const match = matchesExpected(f, expected);
      if (match) matchedIndices.add(i);
      return match;
    });
    if (!found) {
      missed.push(`${expected.category}:${expected.titleContains}@${expected.path}`);
    }
  }

  // Check for false positives (unexpected findings)
  const unexpected: string[] = [];
  let falsePositives = 0;

  for (let i = 0; i < findings.length; i += 1) {
    if (matchedIndices.has(i)) continue;
    const finding = findings[i];

    // Check against notExpected list
    const isNotExpected = fixture.notExpected?.some((pattern) => finding.title.includes(pattern));
    if (isNotExpected) {
      falsePositives += 1;
      unexpected.push(`false-positive:${finding.title}`);
      continue;
    }

    // If fixture expects no findings at all, any finding is a false positive
    if (fixture.expectedFindings.length === 0) {
      falsePositives += 1;
      unexpected.push(`unexpected:${finding.title}`);
    }
  }

  const totalExpected = fixture.expectedFindings.length;
  const detected = matchedIndices.size;
  const detectionRate = totalExpected > 0 ? detected / totalExpected : 1;
  const totalProduced = findings.length;
  const precision = totalProduced > 0 ? (detected) / (detected + falsePositives) : 1;

  return {
    fixtureName: fixture.name,
    totalExpected,
    detected,
    falsePositives,
    missed,
    unexpected,
    detectionRate,
    precision,
  };
}

/**
 * Run full benchmark across all fixtures.
 */
export function runBenchmark(): BenchmarkSummary {
  const fixtures = evalFixtures.map(evaluateFixture);

  const totalExpected = fixtures.reduce((sum, f) => sum + f.totalExpected, 0);
  const totalDetected = fixtures.reduce((sum, f) => sum + f.detected, 0);
  const totalFalsePositives = fixtures.reduce((sum, f) => sum + f.falsePositives, 0);

  const overallDetectionRate = totalExpected > 0 ? totalDetected / totalExpected : 1;
  const overallPrecision = (totalDetected + totalFalsePositives) > 0
    ? totalDetected / (totalDetected + totalFalsePositives)
    : 1;

  return {
    fixtures,
    overallDetectionRate,
    overallPrecision,
    totalExpected,
    totalDetected,
    totalFalsePositives,
  };
}

/**
 * Format benchmark summary as human-readable text.
 */
export function formatBenchmarkReport(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push('=== Review Engine Evaluation Report ===');
  lines.push('');
  lines.push(`Overall Detection Rate: ${(summary.overallDetectionRate * 100).toFixed(1)}% (${summary.totalDetected}/${summary.totalExpected})`);
  lines.push(`Overall Precision: ${(summary.overallPrecision * 100).toFixed(1)}%`);
  lines.push(`False Positives: ${summary.totalFalsePositives}`);
  lines.push('');

  for (const fixture of summary.fixtures) {
    const status = fixture.detectionRate >= 1 && fixture.falsePositives === 0 ? 'PASS' : 'NEEDS IMPROVEMENT';
    lines.push(`[${status}] ${fixture.fixtureName}`);
    lines.push(`  Detection: ${fixture.detected}/${fixture.totalExpected} (${(fixture.detectionRate * 100).toFixed(0)}%), FP: ${fixture.falsePositives}`);
    if (fixture.missed.length > 0) {
      lines.push(`  Missed: ${fixture.missed.join(', ')}`);
    }
    if (fixture.unexpected.length > 0) {
      lines.push(`  Unexpected: ${fixture.unexpected.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
