import { Effect } from 'effect';

// Native file mutations all assert `edit`; keep the revision's narrower tool
// choices in both its catalog filter and actual original tool execution.
const actions = Object.freeze({ write: 'devryan_bot_write', edit: 'devryan_bot_edit', patch: 'devryan_bot_edit' });

export const nativeBotFilePermissions = (rules) => ({ ...rules,
  edit: rules.write === 'allow' || rules.edit === 'allow' ? 'allow' : 'deny',
  devryan_bot_write: rules.write ?? 'deny',
  devryan_bot_edit: rules.edit ?? 'deny',
});

export function installNativeBotToolPolicy(editor, permission) {
  for (const [name, action] of Object.entries(actions)) editor.update(name, definition => {
    const execute = definition.execute;
    definition.options = { ...definition.options, permission: action };
    definition.execute = (input, context) => permission.assert({ action, resources: ['*'], save: ['*'],
      sessionID: context.sessionID, agent: context.agent,
      source: { type: 'tool', messageID: context.messageID, id: context.id },
    }).pipe(Effect.andThen(() => execute(input, context)));
  });
}
