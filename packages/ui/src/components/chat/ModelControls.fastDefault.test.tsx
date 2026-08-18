import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'ModelControls.tsx'), 'utf8');

describe('ModelControls Cursor fast-only controls', () => {
    test('uses the Cursor display label helper for the model-adjacent variant trigger', () => {
        const code = source();

        expect(code).toContain('getCursorAcpVariantDisplayLabel(cursorVariantState, { providerId');
        expect(code).toContain('getCursorAcpVariantDisplayLabel(cursorRowVariantState, { providerId');
    });

    test('renders a Cursor Fast switch in the mobile expanded model row', () => {
        const code = source();

        expect(code).toContain('cursorVariantState?.canToggleFast && provider');
        expect(code).toContain('resolveCursorAcpVariantSelection(provider, modelId, resolvedVariant, { fastEnabled: checked })');
    });

    test('does not render visible Thinking headers or labels in variant controls', () => {
        const code = source();

        expect(code).not.toContain('<DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">{t(\'chat.modelControls.thinking\')}</DropdownMenuLabel>');
        expect(code).not.toContain('<p className="typography-meta">Thinking: {displayVariant}</p>');
        expect(code).not.toContain('<span className="font-medium text-foreground">{t(\'chat.modelControls.thinking\')}</span>');
        expect(code).not.toContain('<span>Thinking: {displayLabel}</span>');
        expect(code).not.toContain("const mobileVariantPanelTitle = cursorFastOnlyPanelTitle ?? t('chat.modelControls.thinking')");
    });

    test('uses the larger model-control fast icon size', () => {
        const code = source();

        expect(code).toContain('inline-flex h-3.5 w-3.5');
        expect(code).toContain('RiFlashlightFill className="h-3.5 w-3.5 text-[var(--status-warning)]"');
    });

    test('keeps descenders visible in both model-adjacent thinking labels', () => {
        const code = source();

        expect(code.match(/inline-flex items-center gap-1 text-\[10px\] leading-\[14px\] -my-\[2px\] py-\[2px\] font-medium min-w-0 truncate text-muted-foreground/g)).toHaveLength(2);
        expect(code.match(/<span className="min-w-0 truncate leading-\[14px\] -my-\[2px\] py-\[2px\]">\{displayVariant\}<\/span>/g)).toHaveLength(2);
    });

    test('does not render compact price text in model picker rows', () => {
        const code = source();

        expect(code).not.toContain('formatCompactPrice(metadata)');
        expect(code).not.toContain('key="price"');
    });

    test('renders hover-only hide and favorite actions for desktop model rows', () => {
        const code = source();

        expect(code).toContain('RiEyeLine');
        expect(code).toContain('const hideModelRefs = useUIStore((state) => state.hideModelRefs);');
        expect(code).toContain('const hiddenRefs = getHiddenModelRefsForProviderModel(providerID, model);');
        expect(code).toContain('hideModelRefs(');
        expect(code).toContain("t('chat.modelControls.hideModelFromSelector')");
        expect(code).toContain("t('chat.modelControls.hideModelAria')");
        expect(code).toContain('group-hover/model-row:opacity-100');
    });

    test('does not render desktop row capability metadata slot', () => {
        const code = source();

        expect(code).not.toContain('Metadata slot: thinking variant for adjusted models, otherwise compact capabilities');
        expect(code).not.toContain('indicatorIcons.map(({ id, icon: Icon, label })');
        expect(code).not.toContain('<TextLoop interval={2.1} transition={{ duration: 0.25 }} trigger={shouldAnimate} reserveSpace={false}>');
    });

    test('show all providers action opens providers settings without add-provider mode', () => {
        const code = source();

        expect(code).toContain('const openProvidersSettings = React.useCallback(() => {');
        expect(code).toContain("setSettingsPage('providers');");
        expect(code).toContain("t('chat.modelControls.showAllProviders')");
        expect(code).not.toContain('const openProvidersSettings = React.useCallback(() => {\\n        setSelectedProvider(ADD_PROVIDER_ID);');
    });

    test('keeps a rehydrated draft variant while the draft agent is still restoring', () => {
        const code = source();

        expect(
            /if \(!contextHydrated\) \{\s*return;\s*\}\s*if \(!currentAgentName\) \{[\s\S]*?if \(!currentSessionId\) \{\s*return;/.test(code),
        ).toBe(true);
    });
});
