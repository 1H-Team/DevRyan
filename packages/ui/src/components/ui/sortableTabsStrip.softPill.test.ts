import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./sortable-tabs-strip.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

describe('soft-pill tabs variant', () => {
  test('exposes soft-pill as a variant and derives it from the pill indicator machinery', () => {
    expect(source).toContain("variant?: 'default' | 'active-pill' | 'animated' | 'soft-pill'");
    expect(source).toContain("const isSoftPillVariant = variant === 'soft-pill';");
    expect(source).toContain('const usesActivePillIndicator = isActivePillVariant || isAnimatedVariant || isSoftPillVariant;');
  });

  test('floats the active pill with no recessed track behind the strip', () => {
    expect(source).toContain('const showPillTrackBackground = usesActivePillIndicator && !isSoftPillVariant;');
  });

  test('fills the active pill with a themeable neutral instead of an elevated surface and border', () => {
    expect(source).toContain("'rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]'");
    expect(source).toContain("'rounded-[9px] bg-[var(--surface-elevated)] border border-border/60'");
  });

  test('hovers the whole row so the fill covers the trailing close control', () => {
    // The close button is a sibling of the tab button, so a fill on the button alone
    // stops short of the X and disappears when the pointer moves onto it.
    expect(source).toContain("isSoftPillVariant && !isActive && 'hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]'");
    expect(source).toContain("isSoftPillVariant && 'rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] transition-colors duration-150'");
    expect(source).toContain("? 'text-muted-foreground group-hover:text-foreground'");
  });

  test('keeps the icon and the close control visible together instead of swapping them', () => {
    expect(source).toContain('const closeReplacesIcon = closable && Boolean(item.icon) && !isSoftPillVariant;');
  });

  test('reveals the close control on hover only, including on the active tab', () => {
    expect(source).toContain('const closeControlVisibilityClass = alwaysShowCloseControls');
    expect(source).toContain("'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'");
    expect(source).not.toContain('(isActive || alwaysShowCloseControls)');
  });

  test('animates the sliding pill by default', () => {
    expect(source).toContain('const shouldAnimateActivePill = animateActivePill ?? (isAnimatedVariant || isSoftPillVariant);');
  });

  test('scopes its own container queries so pill-tabs rules do not leak in', () => {
    expect(source).toContain("isSoftPillVariant ? '@container/soft-tabs' : '@container/pill-tabs'");
    expect(source).toContain("isSoftPillVariant ? 'soft-tabs__track' : 'pill-tabs__track'");
    expect(styles).toContain('@container soft-tabs (max-width: 20rem)');
    expect(styles).toContain('@container soft-tabs (max-width: 12rem)');
    expect(styles).toContain('.soft-tabs__label');
  });
});
