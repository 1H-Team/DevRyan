import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

export const qaDesktopAppearanceExpression = `(() => {
  const root=document.documentElement;
  if(!root)return null;
  const theme=root.classList.contains('dark')?'dark':'light';
  const label=theme==='dark'?'Switch to Light Mode':'Switch to Dark Mode';
  const button=[...document.querySelectorAll('button')].find(element=>element.getAttribute('aria-label')===label);
  const bounds=button?.getBoundingClientRect();
  return {theme,toggleLabel:button?.getAttribute('aria-label')??null,
    toggleReady:!!button&&!button.disabled&&bounds.width>0&&bounds.height>0};
})()`;

export async function assertQaDesktopAppearance({ cdp, theme, evaluatePage = evaluate }) {
  assert.ok(['light','dark'].includes(theme),'Explicit desktop theme must be light or dark');
  const observed=await evaluatePage(cdp, `document.documentElement?.classList.contains('dark')`);
  assert.equal(observed,theme==='dark','Rendered desktop theme differs from the requested matrix cell');
  return {requested:theme,observed:observed?'dark':'light'};
}

/** Exercise the existing SidebarFooter -> ThemeSystemContext.setThemeMode path. */
export async function selectQaDesktopAppearance({ cdp, ui, theme, evaluatePage = evaluate }) {
  assert.ok(['light','dark'].includes(theme),'Explicit desktop theme must be light or dark');
  const before=await ui.waitFor('visible desktop theme toggle',async()=>{
    const value=await evaluatePage(cdp,qaDesktopAppearanceExpression);
    return value?.toggleReady?value:false;
  });
  let clicked=false;
  if(before.theme!==theme){
    await ui.click({label:theme==='dark'?'Switch to Dark Mode':'Switch to Light Mode'});
    clicked=true;
  }
  await ui.waitExpression('requested desktop theme rendered',`document.documentElement.classList.contains('dark')===${JSON.stringify(theme==='dark')}`);
  const observed=await assertQaDesktopAppearance({cdp,theme,evaluatePage});
  const after=await evaluatePage(cdp,qaDesktopAppearanceExpression);
  assert.equal(after?.toggleLabel,theme==='dark'?'Switch to Light Mode':'Switch to Dark Mode','Theme toggle did not reflect the rendered theme');
  return {...observed,initial:before.theme,clicked,source:'actual-sidebar-theme-button'};
}
