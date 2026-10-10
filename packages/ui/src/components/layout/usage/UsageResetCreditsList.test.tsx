import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { UsageResetCredit, UsageResetCredits } from '@/types';
import { UsageResetCreditsList } from './UsageResetCreditsList';

const credit = (overrides: Partial<UsageResetCredit>): UsageResetCredit => ({
  id: overrides.id ?? 'credit',
  status: overrides.status ?? 'available',
  resetType: overrides.resetType ?? 'codex_rate_limits',
  grantedAt: overrides.grantedAt ?? null,
  grantedAtFormatted: overrides.grantedAtFormatted ?? null,
  expiresAt: overrides.expiresAt ?? null,
  expiresAtFormatted: overrides.expiresAtFormatted ?? null,
});

const resetCredits = (overrides: Partial<UsageResetCredits>): UsageResetCredits => ({
  availableCount: overrides.availableCount ?? null,
  totalEarnedCount: overrides.totalEarnedCount ?? null,
  source: overrides.source ?? 'usage',
  credits: overrides.credits ?? [],
});

const renderList = (value: UsageResetCredits | null) => renderToStaticMarkup(
  <I18nProvider>
    <UsageResetCreditsList resetCredits={value} />
  </I18nProvider>
);

describe('UsageResetCreditsList', () => {
  test('unavailable inventory does not invent a zero or expiry; known count-only zero stays visible', () => {
    const unknown = renderList(null);
    expect(unknown).toContain('Reset Bank'); expect(unknown).toContain('Unavailable'); expect(unknown).not.toContain('0 available');
    const known = renderList({ ...resetCredits({ availableCount: 0 }), detailsAvailable: false });
    expect(known).toContain('0 available'); expect(known).toContain('Expiry details unavailable.');
    expect(known).not.toContain('No expiry');
  });
  test('omits the expiry row when credit details are empty', () => {
    const markup = renderList(resetCredits({
      availableCount: 2,
      credits: [],
    }));

    expect(markup).toContain('Reset Bank');
    expect(markup).toContain('2 available');
    expect(markup).not.toContain('Expiry');
    expect(markup).not.toContain('Expiry details unavailable.');
  });

  test('renders expiry chips when available credits include expiry details', () => {
    const markup = renderList(resetCredits({
      availableCount: 1,
      credits: [
        credit({
          id: 'soon',
          expiresAt: Date.parse('2026-07-31T00:00:00.000Z'),
          expiresAtFormatted: 'Jul 31, 2026',
        }),
      ],
    }));

    expect(markup).toContain('Expiry');
    expect(markup).toContain('Jul 31, 2026');
    expect(markup).not.toContain('Expiry details unavailable.');
  });
});
