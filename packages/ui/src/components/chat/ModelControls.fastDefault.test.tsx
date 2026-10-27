import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'ModelControls.tsx'), 'utf8');

describe('ModelControls Cursor fast-only controls', () => {
    test('routes the mobile slider Fast action through the Cursor adapter', () => {
        const code = source();

        expect(code).toContain('(cursorVariantState ?? genericVariantState)?.canToggleFast');
        expect(code).toContain('resolveCursorAcpVariantSelection(provider, modelId, resolvedVariant, { fastEnabled })');
    });

    test('uses the larger model-control fast icon size', () => {
        const code = source();

        expect(code).toContain('inline-flex h-3.5 w-3.5');
        expect(code).toContain('RiFlashlightFill className="h-3.5 w-3.5 text-[var(--status-warning)]"');
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

    test('the rail settings action opens providers settings without add-provider mode', () => {
        const code = source();

        expect(code).toContain('const openProvidersSettings = React.useCallback(() => {');
        expect(code).toContain("setSettingsPage('providers');");
        expect(code).toContain("settingsLabel={t('chat.modelControls.providerSettings')}");
        expect(code).toContain('onOpenSettings={openProvidersSettings}');
        expect(code).not.toContain('openAddProviderSettings');
        expect(code).not.toContain('ADD_PROVIDER_ID');
        expect(code).not.toContain('const openProvidersSettings = React.useCallback(() => {\\n        setSelectedProvider(ADD_PROVIDER_ID);');
    });
});
