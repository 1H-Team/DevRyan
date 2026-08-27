import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(testDir, path), 'utf8');

describe('mobile right sidebar layout', () => {
    test('mobile header tabs exclude files', () => {
        const source = readSource('Header.tsx');
        const tabsStart = source.indexOf('const tabs: TabConfig[] = React.useMemo(() => {');
        const mobileTabsBlock = source.slice(
            source.indexOf('if (isMobile) {', tabsStart),
            source.indexOf('// Desktop: no tabs in header', tabsStart),
        );

        expect(mobileTabsBlock).toContain("{ id: 'chat'");
        expect(mobileTabsBlock).toContain("{ id: 'diff'");
        expect(mobileTabsBlock).toContain("{ id: 'terminal'");
        expect(mobileTabsBlock).not.toContain("{ id: 'files'");
    });

    test('mobile right drawer uses desktop right sidebar tabs', () => {
        const source = readSource('MainLayout.tsx');
        const mobileRightDrawer = source.slice(
            source.indexOf('Right drawer (Source / Files)'),
            source.indexOf('{/* Main content area (fixed) */}'),
        );

        expect(mobileRightDrawer).toContain('<ErrorBoundary><RightSidebarTabs /></ErrorBoundary>');
        expect(mobileRightDrawer).not.toContain('<GitView />');
        expect(mobileRightDrawer).not.toContain('botMode={botMode}');
    });

    test('renders Bot drawer controls in shell chrome outside the identity header', () => {
        const layoutSource = readSource('MainLayout.tsx');
        const headerSource = readSource('Header.tsx');
        const botIdentitySource = readSource('../bots/chat/BotIdentityHeader.tsx');
        const botHeader = headerSource.slice(
            headerSource.indexOf('const renderBotMobile'),
            headerSource.indexOf('const renderDesktop'),
        );

        expect(layoutSource).toContain('data-bot-mobile-edge-controls');
        expect(layoutSource).toContain('<BotSidebarControlButton');
        expect(layoutSource).toContain('onToggle={toggleMobileLeftDrawer}');
        expect(layoutSource).toContain('onToggle={toggleMobileRightDrawer}');
        expect(botHeader).toContain('<BotIdentityHeader');
        expect(botIdentitySource).toContain('data-bot-identity-header="mobile"');
        expect(botHeader).not.toContain('<button');
        expect(botIdentitySource).not.toContain('<button');
    });
});

describe('mobile left sidebar gestures', () => {
    test('starts drawer dragging manually outside locked session rows', () => {
        const source = readSource('MainLayout.tsx');
        const mobileLeftDrawer = source.slice(
            source.indexOf('Left drawer (Session)'),
            source.indexOf('Right drawer (Source / Files)'),
        );

        expect(source).toContain("target.closest('[data-mobile-drawer-drag-lock]')");
        expect(source).toContain('leftDrawerDragControls.start(event)');
        expect(mobileLeftDrawer).toContain('dragControls={leftDrawerDragControls}');
        expect(mobileLeftDrawer).toContain('dragListener={false}');
        expect(mobileLeftDrawer).toContain('onPointerDown={handleLeftDrawerPointerDown}');
    });
});
