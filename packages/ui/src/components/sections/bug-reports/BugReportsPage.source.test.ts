import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('managed Bug Reports settings page', () => {
  test('keeps the three page-local surfaces lazy and admin review exact-role-only', () => {
    const source = readSource('./BugReportsPage.tsx');

    expect(source).toContain("type BugReportsTab = 'submit' | 'reports' | 'errors'");
    expect(source).toContain('const LazySubmitBugReportPanel = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(source).toContain('const LazyBugReportReviewPanel = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(source).toContain('const LazyErrorLogsPanel = /* @__PURE__ */ lazyWithChunkRecovery');
    expect(source).toContain("principal.scope === 'managed' && principal.role === 'admin'");
    expect(source).toContain("principal.scope !== 'managed' || isVSCodeRuntime()");
    expect(source).toContain("visitedTabs.has('reports')");
    expect(source).toContain("visitedTabs.has('errors')");
  });

  test('submits only title and description and clears the draft after confirmation', () => {
    const source = readSource('./SubmitBugReportPanel.tsx');
    const request = source.indexOf('await submitBugReport({ id: submissionId, title, description })');
    const clearTitle = source.indexOf("setTitle('')", request);
    const clearDescription = source.indexOf("setDescription('')", request);
    const catchBlock = source.indexOf('} catch (requestError)', request);

    expect(source).toContain('const TITLE_LIMIT = 200');
    expect(source).toContain('const DESCRIPTION_LIMIT = 20_000');
    expect(source).not.toContain('attachment');
    expect(request).toBeGreaterThan(-1);
    expect(clearTitle).toBeGreaterThan(request);
    expect(clearDescription).toBeGreaterThan(request);
    expect(catchBlock).toBeGreaterThan(clearDescription);
  });

  test('uses accessible row controls, in-page details, status updates, and diagnostics actions', () => {
    const reports = readSource('./BugReportReviewPanel.tsx');
    const errors = readSource('./ErrorLogsPanel.tsx');
    const compactErrors = errors.replace(/\s+/g, ' ');

    expect(reports).toContain('<ul className="space-y-2">');
    expect(reports).toContain('<li key={report.id}>');
    expect(reports).toContain('onClick={() => setSelectedId(report.id)}');
    expect(reports).toContain('updateBugReportStatus(detail.id, status, detail.updatedAt)');
    expect(reports).toContain('requestError.status === 409');
    expect(errors).toContain('<li key={log.eventId}>');
    expect(errors).toContain('onClick={() => setSelectedEventId(log.eventId)}');
    expect(errors).toContain('formatAgentContext(detail)');
    expect(errors).toContain("'DevRyan captured diagnostic'");
    expect(errors).toContain('`Impact: ${log.impact}`');
    expect(errors).toContain('`Classification source: ${log.classificationSource}`');
    expect(errors).toContain('`Failure class: ${log.failureClass}`');
    expect(errors).toContain('`Outcome: ${log.outcome}`');
    expect(errors).toContain("const [impactFilter, setImpactFilter] = React.useState<ImpactFilter>('all')");
    expect(errors).toContain("settings.bugReports.errors.outcome.unknown");
    expect(errors).toContain('const CLEAR_RANGES = [');
    expect(errors).toContain("{ value: '24h'");
    expect(errors).toContain("{ value: '7d'");
    expect(errors).toContain("{ value: '14d'");
    expect(errors).toContain("{ value: 'all'");
    expect(errors).toContain('await clearErrorLogs(range)');
    expect(errors).toContain('setSelectedEventId(null)');
    expect(errors).toContain('setDetail(null)');
    expect(errors).toContain('await reload()');
    expect(errors).toContain("settings.bugReports.errors.clear.success");
    expect(compactErrors).toContain("diagnostics.export({ scope: 'task', sessionID: detail.sessionId,");
  });
});
