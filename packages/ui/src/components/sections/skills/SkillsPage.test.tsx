import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useSkillsStore, type DiscoveredSkill } from '@/stores/useSkillsStore';
import { SkillsPage } from './SkillsPage';

const initialSkillsState = useSkillsStore.getState();
const initialServerSkillsState = { ...useSkillsStore.getInitialState() };

const installedSkill: DiscoveredSkill = {
  name: 'example-skill',
  path: '/Users/test/.config/opencode/skills/example-skill/SKILL.md',
  scope: 'user',
  source: 'opencode',
  description: 'Example skill',
};

const createFilesAPI = (revealPath?: FilesAPI['revealPath']): FilesAPI => ({
  listDirectory: async (path) => ({ directory: path, entries: [] }),
  search: async () => [],
  createDirectory: async (path) => ({ success: true, path }),
  ...(revealPath ? { revealPath } : {}),
});

const renderPage = (files: FilesAPI): string => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={{ files } as RuntimeAPIs}>
    <I18nProvider>
      <SkillsPage />
    </I18nProvider>
  </RuntimeAPIContext.Provider>,
);

const setSkillsState = (state: Partial<ReturnType<typeof useSkillsStore.getState>>) => {
  useSkillsStore.setState(state);
  Object.assign(useSkillsStore.getInitialState(), state);
};

describe('SkillsPage skill path action', () => {
  beforeEach(() => {
    setSkillsState({
      selectedSkillName: installedSkill.name,
      selectedSkillIdentity: [installedSkill.name, installedSkill.path, installedSkill.scope, installedSkill.source].join('\u001f'),
      skills: [installedSkill],
      skillDraft: null,
      isLoading: false,
    });
  });

  test('renders the compact Open action for an installed skill when reveal is available', () => {
    try {
      const markup = renderPage(createFilesAPI(async () => ({ success: true })));

      expect(markup).toContain('~/.config/opencode/skills/example-skill/SKILL.md');
      expect(markup).toContain('Open</button>');
      expect(markup).toContain('type="button"');
    } finally {
      useSkillsStore.setState(initialSkillsState, true);
      Object.assign(useSkillsStore.getInitialState(), initialServerSkillsState);
    }
  });

  test('does not render a dead action when reveal is unavailable', () => {
    try {
      const markup = renderPage(createFilesAPI());

      expect(markup).toContain('~/.config/opencode/skills/example-skill/SKILL.md');
      expect(markup).not.toContain('Open</button>');
    } finally {
      useSkillsStore.setState(initialSkillsState, true);
      Object.assign(useSkillsStore.getInitialState(), initialServerSkillsState);
    }
  });

  test('does not render the path action for a new skill draft', () => {
    try {
      setSkillsState({
        selectedSkillName: 'new-skill',
        selectedSkillIdentity: null,
        skills: [],
        skillDraft: {
          name: 'new-skill',
          scope: 'user',
          source: 'opencode',
          description: '',
        },
      });

      const markup = renderPage(createFilesAPI(async () => ({ success: true })));

      expect(markup).toContain('New Skill');
      expect(markup).not.toContain('Open</button>');
    } finally {
      useSkillsStore.setState(initialSkillsState, true);
      Object.assign(useSkillsStore.getInitialState(), initialServerSkillsState);
    }
  });
});
