import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Audit evidence describes a past checkout. Report its missing targets without
// rewriting the historical record or blocking maintenance of current guidance.
export function isHistoricalDocument(file) {
  return file.startsWith('docs/audits/') || file.startsWith('docs/superpowers/plans/') || file === 'CHANGELOG.md' || file === 'BACKPORT.md';
}

export function withoutCodeBlocks(source) {
  let fence = null;
  return source.split('\n').map((line) => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n').replace(/<!--[\s\S]*?-->/g, '');
}

export function documentReferences(source) {
  const text = withoutCodeBlocks(source);
  const references = [];
  // Explicit source paths in inline code are useful navigation contracts. Shell
  // commands, globs and illustrative placeholders are deliberately not paths.
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const target = match[1];
    if (/^(?:packages|scripts|docs|tests|docker|supabase|\.github|\.opencode)\//.test(target)
      && !/[\s*{}<>|$]/.test(target) && !target.includes('...')
      && /\.[a-zA-Z0-9]+(?::\d+)?$/.test(target)) {
      references.push({ target: target.replace(/:\d+$/, ''), kind: 'source' });
    }
  }
  const prose = text.replace(/`+[^`\n]*`+/g, '');
  for (const match of prose.matchAll(/\]\(\s*/g)) {
    const start = match.index + match[0].length;
    if (prose[start] === '<') {
      const end = prose.indexOf('>', start);
      if (end >= 0) references.push({ target: prose.slice(start + 1, end), kind: 'link' });
      continue;
    }
    let depth = 0;
    let target = '';
    for (let i = start; i < prose.length; i++) {
      const char = prose[i];
      if (char === '\\' && i + 1 < prose.length) { target += prose[++i]; continue; }
      if (char === '(') depth++;
      if (char === ')') { if (depth === 0) break; depth--; }
      if (/\s/.test(char) && depth === 0) break;
      target += char;
    }
    if (target) references.push({ target, kind: 'link' });
  }
  for (const match of prose.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    references.push({ target: match[1] ?? match[2], kind: 'link' });
  }
  for (const match of prose.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    references.push({ target: match[1], kind: 'link' });
  }
  return references;
}

function isGeneratedTarget(target) {
  return /(?:^|\/)(?:\.cache|\.tmp|dist|dist-bundle|target|node_modules)\//.test(target)
    || target.endsWith('/bot-runtime/images.release.json') || target.startsWith('.opencode/plans/');
}

export function validateRepositoryLinks(root, files, { siteRoutes = new Set() } = {}) {
  const errors = [];
  const warnings = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const { target, kind } of documentReferences(source)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
      if (/[<>${}*]/.test(target)) continue;
      let local;
      try { local = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { errors.push(`${file}: invalid URL encoding: ${target}`); continue; }
      if (!local) continue;
      if (file.startsWith('packages/docs/content/') && local.startsWith('/')) {
        if (!siteRoutes.has(local)) errors.push(`${file}: missing documentation route: ${target}`);
        checked++;
        continue;
      }
      const relative = kind === 'source' || local.startsWith('/')
        ? local.replace(/^\//, '') : path.join(path.dirname(file), local);
      let resolved = path.resolve(root, relative);
      // Codemaps also use paths relative to their own package directory.
      if (kind === 'source' && !existsSync(resolved)) {
        const nearby = path.resolve(root, path.dirname(file), local);
        if (nearby.startsWith(path.resolve(root) + path.sep) && existsSync(nearby)) resolved = nearby;
      }
      if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
        errors.push(`${file}: reference leaves repository: ${target}`);
        continue;
      }
      checked++;
      if (isGeneratedTarget(relative)) {
        warnings.push(`${file}: generated target (not checked): ${target}`);
      } else if (!existsSync(resolved)) {
        const message = `${file}: missing ${kind}: ${target}`;
        (isHistoricalDocument(file) ? warnings : errors).push(message);
      }
    }
  }
  return { checked, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
