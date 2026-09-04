import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { dict } from './en';

const testDirectory = dirname(fileURLToPath(import.meta.url));

const MINOR_TITLE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'via',
  'vs',
  'with',
]);

const LOWERCASE_TECHNICAL_WORDS = new Set(['cloudflared', 'macOS', 'npm', 'runsc']);
const LOWERCASE_TECHNICAL_CONTROL_LITERALS = new Set(['bun', 'localhost']);
const APPROVED_SENTENCE_CASE_CONTROL_LITERALS = new Set(['Sign out']);
const CONTROL_ELEMENT_NAMES = new Set([
  'button',
  'Button',
  'Checkbox',
  'CommandItem',
  'DropdownMenuCheckboxItem',
  'DropdownMenuItem',
  'DropdownMenuRadioItem',
  'label',
  'Radio',
  'RadioGroupItem',
  'SelectItem',
  'TabsTrigger',
  'Toggle',
]);
const NON_LABEL_CONTROL_COPY_KEYS = new Set([
  'agentManager.sidebar.item.modelCountPlural',
  'agentManager.sidebar.item.modelCountSingle',
  'agentManager.sidebar.relativeTime.days',
  'agentManager.sidebar.relativeTime.hours',
  'agentManager.sidebar.relativeTime.minutes',
  'agentManager.sidebar.relativeTime.now',
  'agentManager.empty.setupCommands.configured',
  'chat.chatInput.linked.byAuthor',
  'chat.mobileStatus.swipeHint',
  'chat.pendingChanges.changedInWorkspace',
  'chat.queuedMessage.attachments',
  'chat.queuedMessage.empty',
  // Session changed-files card: the muted "Review changes" subtitle and the
  // "Show N more files" disclosure strip are sentence-style by design.
  'chat.sessionChanges.card.reviewChanges',
  'chat.sessionChanges.card.showLess',
  'chat.sessionChanges.card.showMore',
  'desktopHostSwitcher.status.ping',
  'diffView.selector.selectFile',
  'gitView.branch.mergeDescription',
  'gitView.branch.noLocalBranches',
  'gitView.branch.noRemoteBranches',
  'gitView.branch.rebaseDescription',
  'gitView.header.noIdentity',
  'gitView.pr.placeholder.main',
  'gitView.pr.placeholder.selectBaseBranch',
  'session.newWorktree.selectSourceBranchPlaceholder',
  'sessions.scheduledTasks.dialog.project.empty',
  'sessions.scheduledTasks.editor.date.placeholder',
  'sessions.sidebar.folders.none',
  'sessions.sidebar.empty.noSessions.title',
  'sessions.sidebar.session.status.permissionRequired',
  'settings.agents.modelSelector.selectPlaceholder',
  'settings.agents.sidebar.badge.system',
  'settings.commands.agentSelector.notSelected',
  'settings.commands.agentSelector.selectAgentPlaceholder',
  'settings.mcp.page.server.importJsonTitle',
  'settings.mcp.page.transport.local',
  'settings.providers.page.auth.apiKeyTooltip',
  'settings.providers.page.connect.selectProviderPlaceholder',
  'settings.skills.catalog.installFromRepo.badge.installed',
  'settings.skills.catalog.shared.noDescription',
  'settings.skills.catalog.shared.auth.chooseIdentity',
  'settings.usage.sidebar.status.notSet',
  'settings.view.home.cards.agents.description',
  'settings.view.home.cards.mcp.description',
  'settings.view.home.cards.providers.description',
  'settings.view.home.cards.skillsCatalog.description',
  'settings.view.home.cards.usage.description',
]);

function isAuditedControlCopyKey(key: string): boolean {
  if (/(?:Badge|Description|Hint|Placeholder|Tooltip)$/.test(key) || /\.actions\.description$/.test(key)) {
    return false;
  }

  const fieldName = key.match(/\.field\.([^.]+)$/)?.[1];
  const isFieldLabel = Boolean(fieldName)
    && !/(?:description|hint|placeholder|warning|range|unit|permission|status|state|error|unavailable|content|value|noDevices)/i.test(fieldName ?? '')
    && fieldName !== 'days';

  const isKnownInteractiveItem = /^(?:helpDialog\.item\.|sessions\.sidebar\.session\.menu\.|settings\.magicPrompts\.sidebar\.item\.)/.test(key)
    || /^settings\.agents\.page\.mode\./.test(key)
    || /^terminalView\.tabs\..*Title$/.test(key)
    || key === 'settings.openchamber.tunnel.option.moreProvidersSoon';

  return /(?:^|\.)(?:action|actions)\.[^.]+$/.test(key)
    || /\.label$/.test(key)
    || /Label$/.test(key)
    || /Aria$/.test(key)
    || isFieldLabel
    || isKnownInteractiveItem;
}

function findTitleCaseViolations(value: string): string[] {
  const words = value.match(/\{[^}]+\}|[A-Za-z][A-Za-z0-9+&']*/g) ?? [];

  return words.flatMap((word, index) => {
    if (
      word.startsWith('{')
      || /\d/.test(word)
      || LOWERCASE_TECHNICAL_WORDS.has(word)
    ) {
      return [];
    }

    const normalized = word.toLowerCase();
    const isInteriorMinorWord = index > 0
      && index < words.length - 1
      && MINOR_TITLE_WORDS.has(normalized);

    if (isInteriorMinorWord) {
      return word === normalized ? [] : [word];
    }

    return /^[A-Z]/.test(word) ? [] : [word];
  });
}

function collectDisplayStringLiterals(node: ts.Expression, values: string[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    values.push(node.text);
    return;
  }

  if (ts.isParenthesizedExpression(node)) {
    collectDisplayStringLiterals(node.expression, values);
    return;
  }

  if (ts.isConditionalExpression(node)) {
    collectDisplayStringLiterals(node.whenTrue, values);
    collectDisplayStringLiterals(node.whenFalse, values);
    return;
  }

  if (
    ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    collectDisplayStringLiterals(node.left, values);
    collectDisplayStringLiterals(node.right, values);
  }
}

function getJsxTagName(tagName: ts.JsxTagNameExpression): string {
  return ts.isIdentifier(tagName) ? tagName.text : tagName.getText();
}

function isControlElementName(tagName: string): boolean {
  return CONTROL_ELEMENT_NAMES.has(tagName)
    || /(?:Button|Item|Trigger|Checkbox|Radio|Toggle|Label)$/.test(tagName);
}

function collectDisplayI18nKeys(node: ts.Node, keys: Set<string>): void {
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && (node.expression.text === 't' || node.expression.text === 'tUnsafe')
  ) {
    const key = node.arguments[0];
    if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
      keys.add(key.text);
    }
  }

  ts.forEachChild(node, (child) => collectDisplayI18nKeys(child, keys));
}

type ProductionSourceFile = {
  relativePath: string;
  sourceFile: ts.SourceFile;
};

let productionSourceFiles: ProductionSourceFile[] | undefined;
const CONTROL_SOURCE_PATTERN = /(?:aria-label|title)\s*=|<(?:button|label)\b|<[A-Z][A-Za-z0-9.]*(?:Button|Item|Trigger|Checkbox|Radio|Toggle|Label)\b/;

function getProductionSourceFiles(): ProductionSourceFile[] {
  if (productionSourceFiles) {
    return productionSourceFiles;
  }

  const srcRoot = resolve(testDirectory, '../../..');
  const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((filePath) => filePath.endsWith('.tsx') && !filePath.endsWith('.test.tsx'));

  productionSourceFiles = files.flatMap((relativePath) => {
    const absolutePath = resolve(srcRoot, relativePath);
    const source = readFileSync(absolutePath, 'utf8');
    if (!CONTROL_SOURCE_PATTERN.test(source)) {
      return [];
    }

    return [{
      relativePath,
      sourceFile: ts.createSourceFile(
        absolutePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    }];
  });

  return productionSourceFiles;
}

function findHardcodedControlCopyViolations(): string[] {
  const violations: string[] = [];

  for (const { relativePath, sourceFile } of getProductionSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const openingElement = ts.isJsxElement(node) ? node.openingElement : node;
        const tagName = getJsxTagName(openingElement.tagName);
        const values: string[] = [];

        for (const attribute of openingElement.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !attribute.initializer) {
            continue;
          }

          const attributeName = attribute.name.getText(sourceFile);
          if (attributeName !== 'aria-label' && attributeName !== 'title') {
            continue;
          }

          if (ts.isStringLiteral(attribute.initializer)) {
            values.push(attribute.initializer.text);
          } else if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
            collectDisplayStringLiterals(attribute.initializer.expression, values);
          }
        }

        if (isControlElementName(tagName)) {
          const collectChildText = (child: ts.JsxChild): void => {
            if (ts.isJsxText(child)) {
              const value = child.text.replace(/\s+/g, ' ').trim();
              if (value) values.push(value);
              return;
            }

            if (ts.isJsxExpression(child) && child.expression) {
              collectDisplayStringLiterals(child.expression, values);
              return;
            }

            if (ts.isJsxElement(child)) {
              child.children.forEach(collectChildText);
            }
          };

          if (ts.isJsxElement(node)) {
            node.children.forEach(collectChildText);
          }
        }

        for (const value of values) {
          if (
            LOWERCASE_TECHNICAL_CONTROL_LITERALS.has(value)
            || APPROVED_SENTENCE_CASE_CONTROL_LITERALS.has(value)
            || /^\d+[a-z]+$/i.test(value)
          ) {
            continue;
          }

          const invalidWords = findTitleCaseViolations(value);
          if (invalidWords.length === 0) {
            continue;
          }

          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(
            `${relativePath}:${location.line + 1} <${tagName}> ${value} [${invalidWords.join(', ')}]`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

function findTranslatedControlCopyViolations(): string[] {
  const violations: string[] = [];

  for (const { relativePath, sourceFile } of getProductionSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const openingElement = ts.isJsxElement(node) ? node.openingElement : node;
        const tagName = getJsxTagName(openingElement.tagName);

        if (isControlElementName(tagName)) {
          const keys = new Set<string>();

          for (const attribute of openingElement.attributes.properties) {
            if (
              ts.isJsxAttribute(attribute)
              && attribute.initializer
              && ts.isJsxExpression(attribute.initializer)
              && attribute.initializer.expression
              && (attribute.name.getText(sourceFile) === 'aria-label'
                || attribute.name.getText(sourceFile) === 'title')
            ) {
              collectDisplayI18nKeys(attribute.initializer.expression, keys);
            }
          }

          if (ts.isJsxElement(node)) {
            node.children.forEach((child) => {
              if (ts.isJsxExpression(child) && child.expression) {
                collectDisplayI18nKeys(child.expression, keys);
              } else if (ts.isJsxElement(child)) {
                collectDisplayI18nKeys(child, keys);
              }
            });
          }

          for (const key of keys) {
            if (NON_LABEL_CONTROL_COPY_KEYS.has(key) || /placeholder$/i.test(key)) {
              continue;
            }

            const value = dict[key as keyof typeof dict];
            if (typeof value !== 'string') {
              continue;
            }

            const invalidWords = findTitleCaseViolations(value);
            if (invalidWords.length === 0) {
              continue;
            }

            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push(
              `${relativePath}:${location.line + 1} <${tagName}> ${key}: ${value} [${invalidWords.join(', ')}]`,
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

describe('control copy', () => {
  test('keeps the requested project and tunnel actions in title case', () => {
    expect(dict['sessions.sidebar.header.actions.addProject']).toBe('Add Project');
    expect(dict['directoryExplorerDialog.actions.addProject']).toBe('Add Project');
    expect(dict['settings.projects.sidebar.actions.addProject']).toBe('Add Project');
    expect(dict['settings.openchamber.tunnel.actions.startTunnel']).toBe('Start Tunnel');
    expect(dict['settings.openchamber.tunnel.actions.stopTunnel']).toBe('Stop Tunnel');
    expect(dict['chat.fileAttachment.activeEditor.addFile']).toBe('Add File: {name} to Context');
  });

  test('authors notification template labels instead of relying on CSS capitalization', () => {
    expect(dict['settings.notifications.page.template.event.completion']).toBe('Session Completion');
    expect(dict['settings.notifications.page.template.event.error']).toBe('Error');
    expect(dict['settings.notifications.page.template.event.question']).toBe('Question');
  });

  test('keeps Git icon controls descriptive after the copy audit', () => {
    expect(dict['gitView.changes.collapseDirectoryAria']).toBe('Collapse Directory {path}');
    expect(dict['gitView.changes.expandDirectoryAria']).toBe('Expand Directory {path}');
    expect(dict['gitView.changes.revertFileAria']).toBe('Revert File {path}');
    expect(dict['gitView.commit.aiHighlights.insertAria']).toBe('Insert Highlights');
    expect(dict['gitView.commit.commitAria']).toBe('Commit Changes');
  });

  test('uses editorial title case for authored action and control labels', () => {
    const violations = Object.entries(dict).flatMap(([key, value]) => {
      if (!isAuditedControlCopyKey(key)) {
        return [];
      }

      const invalidWords = findTitleCaseViolations(value);
      return invalidWords.length > 0
        ? [`${key}: ${value} [${invalidWords.join(', ')}]`]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test('uses editorial title case for hard-coded JSX control labels', () => {
    expect(findHardcodedControlCopyViolations()).toEqual([]);
  });

  test('uses editorial title case for translated JSX control labels', () => {
    expect(findTranslatedControlCopyViolations()).toEqual([]);
  });
});
