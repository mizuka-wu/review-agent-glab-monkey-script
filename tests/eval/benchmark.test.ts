import { describe, expect, it } from 'vitest';
import { runBenchmark, formatBenchmarkReport } from './benchmark';
import { evalFixtures } from './fixtures';

describe('Review Engine Evaluation Benchmark', () => {
  const summary = runBenchmark();

  it('has evaluation fixtures', () => {
    expect(evalFixtures.length).toBeGreaterThanOrEqual(6);
  });

  it('detects at least 80% of expected findings overall', () => {
    if (process.env.EVAL_VERBOSE) {
      console.log(formatBenchmarkReport(summary));
    }
    expect(summary.overallDetectionRate).toBeGreaterThanOrEqual(0.8);
  });

  it('maintains at least 70% precision overall', () => {
    expect(summary.overallPrecision).toBeGreaterThanOrEqual(0.7);
  });

  it('detects all security findings', () => {
    const securityFixtures = summary.fixtures.filter((f) =>
      f.fixtureName.includes('security') || f.fixtureName.includes('secret') || f.fixtureName.includes('mixed'),
    );
    for (const fixture of securityFixtures) {
      // Security findings are critical — require 100% detection
      const securityMissed = fixture.missed.filter((m) => m.includes('security'));
      expect(securityMissed).toEqual([]);
    }
  });

  it('produces zero false positives on clean code', () => {
    const cleanFixture = summary.fixtures.find((f) => f.fixtureName === 'clean-code-no-findings');
    expect(cleanFixture).toBeDefined();
    expect(cleanFixture!.falsePositives).toBe(0);
  });

  it('detects debug log findings', () => {
    const debugFixture = summary.fixtures.find((f) => f.fixtureName === 'maintainability-debug-logs');
    expect(debugFixture).toBeDefined();
    expect(debugFixture!.detectionRate).toBeGreaterThanOrEqual(0.8);
  });

  it('detects weak type findings', () => {
    const typeFixture = summary.fixtures.find((f) => f.fixtureName === 'bug-weak-types');
    expect(typeFixture).toBeDefined();
    expect(typeFixture!.detectionRate).toBeGreaterThanOrEqual(0.8);
  });

  it('detects missing test findings', () => {
    const testFixture = summary.fixtures.find((f) => f.fixtureName === 'test-missing-regression');
    expect(testFixture).toBeDefined();
    expect(testFixture!.detectionRate).toBeGreaterThanOrEqual(1.0);
  });

  it('does not produce false positive for missing test when test exists', () => {
    const mixedFixture = summary.fixtures.find((f) => f.fixtureName === 'multi-file-mixed');
    expect(mixedFixture).toBeDefined();
    expect(mixedFixture!.unexpected.filter((u) => u.includes('缺少回归测试'))).toEqual([]);
  });
});

describe('Benchmark report formatting', () => {
  it('formats report with all fixture names', () => {
    const summary = runBenchmark();
    const report = formatBenchmarkReport(summary);
    for (const fixture of evalFixtures) {
      expect(report).toContain(fixture.name);
    }
  });
});
