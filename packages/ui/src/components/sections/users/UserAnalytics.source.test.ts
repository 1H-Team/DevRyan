import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const detailSource = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('./UserAnalytics.tsx', import.meta.url), 'utf8');
const activitySource = readFileSync(new URL('./ActivitySection.tsx', import.meta.url), 'utf8');
const chartSource = readFileSync(new URL('./MetricTrendChart.tsx', import.meta.url), 'utf8');
const scrubberSource = readFileSync(new URL('./DayScrubber.tsx', import.meta.url), 'utf8');
const presentationSource = readFileSync(new URL('./userAnalyticsPresentation.ts', import.meta.url), 'utf8');
const permissionsSource = readFileSync(new URL('./SettingsPermissionMatrix.tsx', import.meta.url), 'utf8');

describe('user detail tabs and analytics source contract', () => {
  test('keeps drafts mounted under the ordered accessible tab list', () => {
    const core = detailSource.indexOf('>Core Details</Tabs.Tab>');
    const policy = detailSource.indexOf('>Policy Overrides</Tabs.Tab>');
    const analytics = detailSource.indexOf('>Analytics</Tabs.Tab>');
    expect(core).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(core);
    expect(analytics).toBeGreaterThan(policy);
    expect(detailSource).toContain('value="core" keepMounted');
    expect(detailSource).toContain('value="policy" keepMounted');
    expect(detailSource).toContain('value="analytics" keepMounted');
  });

  test('defaults the two primary policy groups open and advanced JSON closed', () => {
    expect(detailSource).toContain('React.useState(true);\n  const [capabilityPolicyOpen');
    expect(detailSource).toContain('const [advancedPolicyOpen, setAdvancedPolicyOpen] = React.useState(false)');
    expect(detailSource).toContain('{permissionOverrideCount} Overrides');
    expect(detailSource).toContain('{capabilityOverrideCount} Overrides');
    expect(detailSource).toContain('{advancedOverrideCount} Keys');
  });

  test('renders every inherited permission and capability with its effective On or Off value', () => {
    expect(permissionsSource).toContain("`Inherit (${safeInherited[slug].read ? 'On' : 'Off'})`");
    expect(permissionsSource).toContain("`Inherit (${safeInherited[slug].edit ? 'On' : 'Off'})`");
    expect(detailSource).toContain("`Inherit (${policyDraft.inheritedCapabilities[key] ? 'On' : 'Off'})`");
    expect(permissionsSource).not.toContain('Inherit ·');
  });

  test('centers the detail tabs in a content-width container', () => {
    expect(detailSource).toContain('<div className="flex justify-center">');
    expect(detailSource).toContain('inline-flex max-w-full overflow-x-auto');
    expect(detailSource).not.toContain('flex min-w-max items-center gap-1');
  });

  test('lazily fetches ranged analytics and renders the metric graph', () => {
    expect(analyticsSource).toContain("if (!active || !canViewDetailed) return");
    expect(analyticsSource).toContain('controller.abort()');
    expect(analyticsSource).toContain('devryan.user-analytics.time-zone');
    expect(analyticsSource).toContain("supported.includes('UTC') ? supported : ['UTC', ...supported]");
    expect(analyticsSource).toContain('/analytics/range?');
    expect(analyticsSource).toContain('new URLSearchParams({ start: range.start, end: range.end, timeZone })');
    expect(analyticsSource).toContain('<MetricTrendChart series={rangeData.series} selectedDate={selectedDate} />');
    expect(analyticsSource).toContain('<details key={group.key}');
    expect(analyticsSource).toContain("params.set('limit', '50')");
    expect(analyticsSource).toContain('Analytics could not be loaded');
    expect(analyticsSource).toContain('No analytics are available.');
  });

  test('formats prompt agent, model, and thinking metadata through shared helpers', () => {
    expect(analyticsSource).toContain("formatPromptAgentLabel(metadataString(event, 'agent'))");
    expect(analyticsSource).toContain("formatPromptThinkingLabel(metadataString(event, 'variant'), provider)");
    expect(analyticsSource).toContain('formatPromptModelLabel(provider, model)');
    expect(presentationSource).toContain('formatAgentDisplayName');
    expect(presentationSource).toContain('formatEffortLabel');
    expect(presentationSource).toContain("'Default Agent'");
  });

  test('renders a range control with presets and a theme-aware metric chart', () => {
    expect(analyticsSource).toContain('const RANGE_PRESETS = [7, 14, 30]');
    // Presets are primary; From/To are the only two stacked labels, revealed under Custom.
    expect(analyticsSource.match(/<label className="flex flex-col gap-1 typography-micro text-muted-foreground">/g)).toHaveLength(2);
    expect(analyticsSource).toContain('const customActive = !presetActive');
    expect(analyticsSource).toContain('onClick={() => setShowCustom(true)}');
    expect(analyticsSource).toContain('{customActive ? (');
    expect(analyticsSource).toContain('<Button variant="outline" onClick={() => setReloadNonce');
    expect(chartSource).toContain('role="img"');
    expect(chartSource).toContain('var(--chart-1)');
    expect(chartSource).toContain('aria-pressed={active}');
  });

  test('title-cases section headings and de-duplicates prompt metadata', () => {
    expect(analyticsSource).toContain('>Activity Sessions</h3>');
    expect(analyticsSource).toContain('>Activity Graph</h3>');
    expect(analyticsSource).toContain('>Changes & Interactions</h3>');
    // Model + thinking metadata render exactly once, in the collapsed summary.
    expect(analyticsSource.match(/tip="Model"/g)).toHaveLength(1);
    expect(analyticsSource.match(/tip="Thinking level"/g)).toHaveLength(1);
    expect(analyticsSource).toContain('formatPromptRowSummary(promptText)');
    expect(analyticsSource).toContain("pluralize(attachmentCount, 'attachment')");
    expect(analyticsSource).toContain('flex shrink-0 flex-col items-end');
    expect(analyticsSource).toContain('whitespace-pre-wrap break-words font-sans typography-ui-label');
    expect(analyticsSource).not.toContain('<pre className="max-h-96');
  });

  test('drives an authoritative single-day scrubber that scopes every detail request', () => {
    expect(analyticsSource).toContain('const [selectedDate, setSelectedDate] = React.useState<string | null>(null)');
    expect(analyticsSource).toContain('const selectDay =');
    expect(analyticsSource).toContain('const clearDay =');
    expect(analyticsSource).toContain('<DayScrubber');
    expect(analyticsSource).toContain('resolveAnalyticsDetailRange(range, selectedDate)');
    expect(analyticsSource).toContain('loadedDetailScope !== detailScopeKey');
    expect(analyticsSource).toContain('events={prompts}');
    expect(analyticsSource).toContain('interactionEvents.map');
    // The chart highlights one selected day and resolves hover identity by date.
    expect(chartSource).toContain('selectedDate');
    expect(chartSource).toContain('resolveMetricTrendHover(series, hoveredDate)');
    expect(chartSource).toContain('var(--primary-base)');
    // The scrubber is an accessible group of day selectors, not look-alike data cards.
    expect(scrubberSource).toContain('role="group"');
    expect(scrubberSource).toContain('aria-pressed={selected}');
  });

  test('attaches the day scrubber beneath the chart in the same chronological order', () => {
    // No reversed ribbon: the scrubber and chart both consume rangeData.series as-is.
    expect(analyticsSource).not.toContain('activityRibbonDays');
    expect(analyticsSource).toContain('onSelect={selectDay}');
    expect(analyticsSource).toContain('sessionCountByDate={sessionCountByDate}');
    expect(analyticsSource).toContain('<MetricTrendChart series={rangeData.series} selectedDate={selectedDate} />');
  });

  test('renders retained session deletion markers and explains protected activity purges', () => {
    expect(analyticsSource).toContain("event.action === 'session.deleted'");
    expect(analyticsSource).toContain('Archived session permanently deleted · analytics retained indefinitely');
    expect(analyticsSource).toContain('Session content deleted, but ownership cleanup did not complete');
    expect(activitySource).toContain('Purge Unprotected Activity');
    expect(activitySource).toContain('protected analytics records retained');
    expect(activitySource).toContain('result.deletedCount');
    expect(activitySource).toContain('result.protectedCount');
  });

  test('renders clipboard previews eagerly and loads full copied text only when expanded', () => {
    expect(analyticsSource).toContain('summary.preview || \'(Empty copied text)\'');
    expect(analyticsSource).toContain('if (toggleEvent.currentTarget.open) void loadFullText()');
    expect(analyticsSource).toContain('/analytics/clipboard/${encodeURIComponent(event.event_id)}');
    expect(analyticsSource).toContain('if (!summary?.available || detail || loading || !event.event_id) return');
    expect(analyticsSource).toContain('max-h-80 overflow-auto whitespace-pre-wrap');
    expect(analyticsSource).toContain('Sensitive-looking values were redacted before storage.');
    expect(analyticsSource).toContain('Text was not captured');
  });
});
