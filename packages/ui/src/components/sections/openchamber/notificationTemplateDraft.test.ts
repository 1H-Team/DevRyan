import { describe, expect, test } from 'bun:test';

import { createNotificationTemplateDraftController } from './notificationTemplateDraft';

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('notification template draft controller', () => {
  test('coalesces rapid edits and commits the complete final value', async () => {
    const commits: Array<[string, string]> = [];
    let visible = { title: '', message: '' };
    const controller = createNotificationTemplateDraftController({
      initial: visible,
      debounceMs: 20,
      onDraftChange: (draft) => { visible = draft; },
      commit: (field, value) => { commits.push([field, value]); },
    });

    controller.update('title', 'f');
    controller.update('title', 'fa');
    controller.update('title', 'fast');

    expect(visible.title).toBe('fast');
    expect(commits).toEqual([]);
    await wait(30);
    expect(commits).toEqual([['title', 'fast']]);
  });

  test('flushes the latest draft immediately on blur or disposal', () => {
    const commits: Array<[string, string]> = [];
    const controller = createNotificationTemplateDraftController({
      initial: { title: '', message: '' },
      onDraftChange: () => undefined,
      commit: (field, value) => { commits.push([field, value]); },
    });

    controller.update('title', 'blurred');
    controller.flush('title');
    controller.update('message', 'unmounted');
    controller.dispose();

    expect(commits).toEqual([
      ['title', 'blurred'],
      ['message', 'unmounted'],
    ]);
  });

  test('does not replace a dirty field while synchronizing external settings', () => {
    let visible = { title: 'Initial', message: 'Initial message' };
    const controller = createNotificationTemplateDraftController({
      initial: visible,
      onDraftChange: (draft) => { visible = draft; },
      commit: () => undefined,
    });

    controller.update('title', 'Local title');
    controller.sync({ title: 'Server title', message: 'Server message' });

    expect(visible).toEqual({ title: 'Local title', message: 'Server message' });
    controller.dispose();
  });

  test('waits for IME composition to finish before scheduling a commit', async () => {
    const commits: Array<[string, string]> = [];
    const controller = createNotificationTemplateDraftController({
      initial: { title: '', message: '' },
      debounceMs: 20,
      onDraftChange: () => undefined,
      commit: (field, value) => { commits.push([field, value]); },
    });

    controller.beginComposition('message');
    controller.update('message', '入');
    await wait(30);
    expect(commits).toEqual([]);

    controller.endComposition('message', '入力');
    await wait(30);
    expect(commits).toEqual([['message', '入力']]);
  });
});
