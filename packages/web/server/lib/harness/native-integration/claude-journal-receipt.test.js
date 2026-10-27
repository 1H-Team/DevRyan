// Web-host integration: the native Claude stderr receipt through the harness journal.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDiagnosticJournal } from '../../../../../harness-runtime/lib/journal.js';
import { createDiagnosticSanitizer } from '../../../../../harness-runtime/lib/sanitizer.js';
import { createClaudeStderrDiagnostic } from '../../opencode/runtime-host/native-claude-diagnostics.js';

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-journal-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createJournal = (directory, options = {}) => createDiagnosticJournal({
  directory,
  sanitizer: createDiagnosticSanitizer({ homeDir: '/Users/tester' }),
  runtime: 'test',
  ...options,
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test('finite Claude process event survives journal disk and export without stderr, credentials or unknown clues',async()=>{
 const directory=await temporaryDirectory(),sanitizer=createDiagnosticSanitizer({homeDir:'/Users/tester'});
 const journal=createJournal(directory,{sanitizer,blobThresholdBytes:100000});
 const scanner=createClaudeStderrDiagnostic();scanner.write('Unknown option --private-secret https://private.example /private/account.json');
 const payload={attemptID:'a'.repeat(64),providerInstanceID:'b'.repeat(32),...scanner.receipt(1,null)};
 journal.enqueue({type:'lifecycle',event:'native_claude_process',sessionID:'ses_claude_receipt',directory:'/fixture/project',payload:{...payload,
  stderr:'private raw stderr',headers:{authorization:'Bearer private-token'},receipt:{clues:['private-nested-secret']},accessToken:'private-token',
  clues:[...payload.clues,'private-clue']}});
 await journal.flush();
 try{
  const records=await journal.readRecords();expect(records).toHaveLength(1);expect(records[0].payload).toEqual(payload);
  expect(sanitizer.sanitizeExportValue(records)).toEqual(records);
  const bucket=path.join(directory,'sessions','ses_claude_receipt'),segments=(await fs.readdir(bucket)).filter(name=>name.endsWith('.ndjson.open'));
  expect(segments).toHaveLength(1);const stored=await fs.readFile(path.join(bucket,segments[0]),'utf8');
  expect(stored).not.toMatch(/private|authorization|accessToken|"stderr":|headers|"receipt":/);
 }finally{await journal.close();}
});
