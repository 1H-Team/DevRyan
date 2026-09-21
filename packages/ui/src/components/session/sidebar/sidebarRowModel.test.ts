import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { createSidebarRowModel, flattenSessionRows, selectableModelRows, sessionModelRows } from './sidebarRowModel';
import type { SessionNode } from './types';

const node = (id: string, children: SessionNode[] = []): SessionNode => ({
  session: { id, directory: '/project' } as Session, children, worktree: null,
});
test('flattens only expanded descendants and expands the search model without DOM rows', () => {
  const nodes = [node('a', [node('child')]), node('b')];
  expect(flattenSessionRows(nodes, new Set(), false, '/project').map((row) => row.node.session.id)).toEqual(['a', 'b']);
  expect(flattenSessionRows(nodes, new Set(['a']), false, '/project').map((row) => row.depth)).toEqual([0, 1, 0]);
  expect(flattenSessionRows(nodes, new Set(), true, '/project')).toHaveLength(3);
});
test('selection covers all 500 logical rows regardless of viewport and respects scope', () => {
  const model = createSidebarRowModel();
  const rows = sessionModelRows(flattenSessionRows(Array.from({ length: 500 }, (_, index) => node(`s${index}`)), new Set(), false, '/project'), false);
  model.set('project', 1, rows);
  model.set('other', 0, [{ id: 'other', scope: '/other', archived: true, selectable: true, descendants: [] }]);
  expect(model.getRows()[0].id).toBe('other');
  expect(selectableModelRows(model.getRows(), '/project')).toHaveLength(500);
  const snapshot = model.getRows(); model.set('project', 1, rows.map((row) => ({ ...row })));
  expect(model.getRows()).toBe(snapshot);
});
test('archive ancestors remain in the visual model but cannot be selected', () => {
  const parent = { ...node('active-parent', [node('archived-child')]), isArchiveAncestorOnly: true };
  const rows = sessionModelRows(flattenSessionRows([parent], new Set(['active-parent']), false, '/project'), true);
  expect(rows).toHaveLength(2); expect(selectableModelRows(rows).map((row) => row.id)).toEqual(['archived-child']);
});
