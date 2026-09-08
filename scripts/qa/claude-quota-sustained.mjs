// Authored React editing workload. Seeding and grading are local-only; the
// independent grader lives outside the model's editable fixture directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixtureGit, requireCacheDirectory, repository } from './claude-quota-fixture.mjs';

const template = path.join(import.meta.dirname, 'fixtures/claude-review-workbench');
const editable = new Set(['review-domain.ts', 'ReviewWorkbench.tsx', 'ReviewFilters.tsx', 'ReviewSummary.tsx',
  'ReviewList.tsx', 'review-workbench.css', 'review-workbench.test.tsx']);
const brief = text => `${text}\nRead the relevant existing files before editing. Implement this brief now, preserving every earlier requirement. Work only in the README's editable files; do not install dependencies. Make real TypeScript/TSX and CSS changes, extend review-workbench.test.tsx with behavior or React server-rendering regressions, and run bun test. Keep data-review-id on review articles. Briefly report what changed and the test result.`;

export const sustainedPrompts = [
  brief('Implement search and rating filters in this review workbench. selectReviews must combine an optional trimmed, case-insensitive literal query over title/body/author, minRating (inclusive), and verifiedOnly. Empty query means no search. Preserve input order and never mutate input. ReviewWorkbench must render only matching reviews and a result count in aria-live="polite". Add labeled search, minimum-rating and verified controls reflecting filters props, and style the filter layout for narrow screens. These are controlled presentation components; no browser state or network persistence is required.'),
  brief('Add moderation status filtering: filters.status is all, pending, published, or hidden; absent/all includes every status. Combine it with all existing filters. Add a labeled status select reflecting props and a visible status badge to every rendered article. Use distinct theme-neutral badge styles and preserve the result count and earlier controls.'),
  brief('Add deterministic sorting to selectReviews: newest (default), oldest, rating-high, rating-low, and helpful. Dates sort by timestamp, invalid dates last in either date direction; rating-high/low use rating; helpful uses helpfulVotes descending. All ties retain original input order. Add a labeled sort select with these values reflecting props; refine card metadata spacing and tabular numeric styles.'),
  brief('Add export paginateReviews(reviews, page = 1, pageSize = 5) returning {items,total,page,pageSize,totalPages}. Truncate finite page/pageSize values; clamp pageSize to 1..50, use 5 for nonfinite pageSize, and clamp page to 1..totalPages (nonfinite becomes 1). Empty input returns page=1,totalPages=1,items=[]. ReviewWorkbench must paginate the selected/sorted set from props page and pageSize. Show a labeled pagination nav, Page X of Y, and Previous/Next buttons disabled at boundaries. Add responsive pagination styling. Preserve full matching result count.'),
  brief('Correct summarizeReviews: exclude hidden reviews and ratings that are nonfinite, noninteger, or outside 1..5. Return count, average (0 when empty), verifiedCount, and histogram with numeric keys 1..5. Do not mutate inputs. Render this summary for the full matching set before pagination, including average and a visible 1..5 distribution with accessible labels. Style histogram bars and aligned counts.'),
  brief('Add export exportReviewsCsv(reviews): CSV columns exactly id,author,rating,title,status; header first, CRLF between records and no trailing CRLF. String cells whose first character is tab/CR, or whose trimStart value begins with =,+,-,@, must be prefixed with a single apostrophe while preserving original whitespace/text. Then CSV-quote cells containing comma, double quote, CR or LF, doubling embedded double quotes. Do not mutate input. Add an Export CSV anchor with download="reviews.csv" and data:text/csv;charset=utf-8, plus encodeURIComponent of CSV for the entire filtered/sorted set, including rows outside the current page. Style it as a secondary action.'),
  brief('Add export updateReviewStatus(reviews, selectedIds, status). It must validate status at runtime (pending/published/hidden only, otherwise throw), ignore unknown or duplicate IDs, and return the same array for no-op updates. For real changes return a new array, preserving references of unchanged reviews and all other fields. ReviewWorkbench passes selectedIds to ReviewList; every article gets a checkbox with accessible name Select review by AUTHOR, checked from selectedIds. Add visible Publish and Hide bulk-action buttons, disabled when no existing review is selected, and style the selection toolbar. Presentation only; no click-handler persistence required.'),
  brief('Add export updateReviewReply(reviews, id, reply). Trim reply; empty text removes the reply property, unknown IDs and unchanged normalized text return the same array. Reject normalized replies longer than 500 Unicode code points by throwing. For changes preserve unchanged review references and other fields. Render existing replies in blockquotes inside their review articles using React text escaping; style replies and include a clear Reply label. Preserve all previous functionality.'),
  brief('Add export highlightReviewText(text, query) returning {text,match}[]; trim query and match literal substrings case-insensitively, left-to-right without overlap. Preserve every original character, omit empty segments, and return [{text,match:false}] when query is empty or not found (also for empty text). Render matching title/body/author segments as React <mark> text nodes, never innerHTML. Style marks with readable contrast and preserve selection controls/status/replies.'),
  brief('Add export getReviewView(reviews, filters = {}, page = 1, pageSize = 5) returning {matched,summary,pagination}, composed from selectReviews, summarizeReviews and paginateReviews. Use this composition in ReviewWorkbench. An empty matched set shows role="status" with No matching reviews and a Clear filters button; keep result count, full-set summary, export and pagination semantics correct. Add an empty-state layout and cross-feature tests for status+query+sort+page combinations.'),
  brief('Improve accessibility across the workbench: use a form with aria-label="Review filters"; every rendered rating has aria-label="RATING out of 5 stars"; pagination nav has aria-label="Review pagination" and the current page text has aria-current="page". Keep all controls labeled, disabled semantics correct and aria-live result count. Add visible keyboard focus styles and a prefers-reduced-motion: reduce rule. Add server-rendering tests using special characters in review data, plus tests that compose filtering, pagination and selection.'),
  brief('Finish the compact layout and audit the completed workbench. ReviewWorkbench compact prop must emit data-density="compact" or "comfortable" on the main element. Use a CSS [data-density="compact"] rule with gap: 8px and compact card spacing; retain the comfortable layout. Add cross-feature regression tests covering filtered CSV beyond one page, immutable moderation/replies, and safe highlight rendering. Run bun test and bun build ReviewWorkbench.tsx --target browser --outdir build. Fix any remaining contract or rendering mistakes while preserving all earlier briefs. The ignored build directory is the only permitted generated output.'),
];

export async function seedSustainedFixture(workspace) {
  await requireCacheDirectory(workspace);
  await fs.cp(template, workspace, { recursive: true });
  await fs.rename(path.join(workspace, 'review-workbench.test.tsx.template'), path.join(workspace, 'review-workbench.test.tsx'));
  const requireUi = createRequire(path.join(repository, 'packages/ui/package.json'));
  await fs.mkdir(path.join(workspace, 'node_modules'));
  for (const name of ['react', 'react-dom']) {
    const installed = path.dirname(requireUi.resolve(`${name}/package.json`));
    await fs.symlink(installed, path.join(workspace, 'node_modules', name), 'dir');
  }
  fixtureGit(workspace, ['init', '--quiet']);
  fixtureGit(workspace, ['add', '.']);
  fixtureGit(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Initial review workbench']);
}

export async function sustainedFileHashes(workspace) {
  return Object.fromEntries(await Promise.all([...editable].map(async name => [name,
    createHash('sha256').update(await fs.readFile(path.join(workspace, name))).digest('hex')])));
}

export async function verifySustainedFixture(workspace, { turn, beforeHashes }) {
  const checks = {};
  const afterHashes = await sustainedFileHashes(workspace);
  const changed = [...editable].filter(name => beforeHashes[name] !== afterHashes[name]);
  checks.actualSourceEdits = changed.some(name => /\.tsx?$/.test(name) && !name.includes('.test.'));
  checks.actualCssEdits = changed.includes('review-workbench.css');
  checks.actualTestEdits = changed.includes('review-workbench.test.tsx');
  const names = fixtureGit(workspace, ['diff', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean);
  const newNames = fixtureGit(workspace, ['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
  const unexpectedFiles = [...names, ...newNames].filter(name => !editable.has(name));
  checks.editableScope = unexpectedFiles.length === 0;
  const run = (args, timeout = 30_000) => execFileSync('bun', args, { cwd: workspace, encoding: 'utf8',
    timeout, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const failures = [];
  for (const [name, args] of [['modelRegressionTests', ['test']], ['independentBehavior',
    [path.join(import.meta.dirname, 'claude-quota-sustained-grade.mjs'), workspace, String(turn)]]]) {
    try { run(args); checks[name] = true; }
    catch (error) { checks[name] = false; failures.push({ name, output: String(error.stderr || error.stdout || error.message).slice(-7000) }); }
  }
  if (turn === sustainedPrompts.length - 1) {
    try {
      run(['build', 'ReviewWorkbench.tsx', '--target', 'browser', '--outdir', 'build']);
      checks.browserBuild = true;
      const outputs = await fs.readdir(path.join(workspace, 'build'));
      checks.browserStyles = (await Promise.all(outputs.filter(name => name.endsWith('.css'))
        .map(async name => (await fs.stat(path.join(workspace, 'build', name))).size > 0))).some(Boolean);
    }
    catch (error) { checks.browserBuild = false; failures.push({ name: 'browserBuild', output: String(error.stderr || error.message).slice(-4000) }); }
  }
  return { passed: Object.values(checks).every(Boolean), checks, changed, unexpectedFiles, failures, afterHashes,
    sourceDiffSha256: createHash('sha256').update(fixtureGit(workspace, ['diff', 'HEAD'])).digest('hex') };
}
