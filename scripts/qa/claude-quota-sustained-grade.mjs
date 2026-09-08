// Run with Bun. This black-box grader is deliberately outside the model's
// editable project; it verifies public functions and rendered React markup.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(process.argv[2]);
const phase = Number(process.argv[3]);
if (!Number.isInteger(phase) || phase < -1 || phase > 11) throw new Error('Invalid grader phase');
const local = createRequire(path.join(workspace, 'package.json'));
const { createElement } = local('react');
const { renderToStaticMarkup } = local('react-dom/server');
const domain = await import(pathToFileURL(path.join(workspace, 'review-domain.ts')).href);
const { ReviewWorkbench } = await import(pathToFileURL(path.join(workspace, 'ReviewWorkbench.tsx')).href);
const { sampleReviews } = await import(pathToFileURL(path.join(workspace, 'review-data.ts')).href);
const render = (reviews = sampleReviews, props = {}) => renderToStaticMarkup(createElement(ReviewWorkbench, { reviews, ...props }));
const ids = rows => rows.map(row => row.id);
const renderedIds = html => [...html.matchAll(/data-review-id="([^"]+)"/g)].map(match => match[1]);
const plainText = html => html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#x27|#39);/g,
  entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" })[entity]).replace(/\s+/g, ' ').trim();
const disabledButton = (html, label) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  .some(([, attrs, body]) => /\bdisabled(?:\s|=|$)/.test(attrs)
    && (attrs.match(/aria-label="([^"]*)"/)?.[1] ?? plainText(body)).includes(label));
const checkedCheckbox = (html, name) => {
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  return [...html.matchAll(/<input\b([^>]*)>/g)].some(([tag, attrs]) => {
    if (!/type="checkbox"/.test(attrs) || !/\bchecked(?:\s|=|$)/.test(attrs)) return false;
    const explicit = attrs.match(/aria-label="([^"]*)"/)?.[1];
    if (explicit !== undefined) return plainText(explicit) === name;
    const id = attrs.match(/\bid="([^"]*)"/)?.[1];
    return labels.some(([, labelAttrs, body]) => ((id && labelAttrs.match(/\bfor="([^"]*)"/)?.[1] === id)
      || body.includes(tag)) && plainText(body) === name);
  });
};
const review = (id, extra = {}) => ({ id, author: `Author ${id}`, title: `Title ${id}`, body: `Body ${id}`,
  rating: 4, createdAt: '2026-08-01T00:00:00Z', verified: true, status: 'published', helpfulVotes: 2, ...extra });
const freeze = rows => Object.freeze(rows.map(row => Object.freeze(row)));
assert.match(render(), /Review workbench/);

if (phase >= 0) {
  const input = freeze([review('a', { title: 'A HELPFUL visit', rating: 5 }),
    review('b', { body: 'Helpful notes', rating: 3 }), review('c', { author: 'Helpful person', verified: false }),
    review('d', { title: 'Unrelated' })]);
  assert.deepEqual(ids(domain.selectReviews(input, { query: ' helpful ', minRating: 4, verifiedOnly: true })), ['a']);
  assert.deepEqual(ids(domain.selectReviews(input, { query: 'helpful' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(domain.selectReviews(input, { query: '  ' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(renderedIds(render(input, { filters: { query: ' helpful ', minRating: 4, verifiedOnly: true } })), ['a']);
  assert.match(render(), /aria-live="polite"/);
}
if (phase >= 1) {
  const input = freeze([review('a'), review('b', { status: 'pending' }), review('c', { status: 'hidden' })]);
  for (const status of ['published', 'pending', 'hidden']) {
    assert.equal(domain.selectReviews(input, { status }).length, 1);
  }
  assert.equal(domain.selectReviews(input, { status: 'all' }).length, 3);
  assert.match(render(input, { filters: { status: 'pending' } }), /pending/i);
  assert.deepEqual(renderedIds(render(input, { filters: { status: 'pending' } })), ['b']);
}
if (phase >= 2) {
  const input = freeze([review('a', { createdAt: '2026-08-02', rating: 2, helpfulVotes: 1 }),
    review('b', { createdAt: 'invalid', rating: 5, helpfulVotes: 8 }),
    review('c', { createdAt: '2026-08-01', rating: 5, helpfulVotes: 8 }),
    review('d', { createdAt: '2026-08-02', rating: 4, helpfulVotes: 3 })]);
  const expected = { newest: ['a', 'd', 'c', 'b'], oldest: ['c', 'a', 'd', 'b'],
    'rating-high': ['b', 'c', 'd', 'a'], 'rating-low': ['a', 'd', 'b', 'c'], helpful: ['b', 'c', 'd', 'a'] };
  for (const [sort, order] of Object.entries(expected)) assert.deepEqual(ids(domain.selectReviews(input, { sort })), order);
  assert.deepEqual(ids(domain.selectReviews(input)), expected.newest);
}
if (phase >= 3) {
  const input = freeze(Array.from({ length: 12 }, (_, i) => review(String(i))));
  assert.deepEqual(domain.paginateReviews(input, 99, 5), { items: input.slice(10), total: 12, page: 3, pageSize: 5, totalPages: 3 });
  assert.deepEqual(domain.paginateReviews([], 0, 0), { items: [], total: 0, page: 1, pageSize: 1, totalPages: 1 });
  assert.deepEqual(domain.paginateReviews(input, NaN, Infinity), { items: input.slice(0, 5), total: 12, page: 1, pageSize: 5, totalPages: 3 });
  assert.equal(domain.paginateReviews(input, 1.9, 100).pageSize, 50);
  assert.equal(domain.paginateReviews(input, -7, 3.9).pageSize, 3);
  assert.deepEqual(renderedIds(render(sampleReviews, { page: 2, pageSize: 5 })), ['r6', 'r7', 'r8', 'r9', 'r10']);
  const first = render(input, { page: 1, pageSize: 5 });
  assert.ok(disabledButton(first, 'Previous'));
  assert.ok(disabledButton(render(input, { page: 3, pageSize: 5 }), 'Next'));
}
if (phase >= 4) {
  const input = freeze([review('a', { rating: 5 }), review('b', { rating: 3, verified: false }),
    review('hidden', { rating: 1, status: 'hidden' }), ...[NaN, Infinity, 0, 6, 2.5].map((rating, i) => review(`bad${i}`, { rating }))]);
  assert.deepEqual(domain.summarizeReviews(input), { count: 2, average: 4, verifiedCount: 1,
    histogram: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 } });
  assert.deepEqual(domain.summarizeReviews([]), { count: 0, average: 0, verifiedCount: 0,
    histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
}
if (phase >= 5) {
  const input = freeze([review('x', { author: '=SUM(1,2)', title: 'A "quote"\nnext' }),
    review('y', { author: '  +calc', title: '@formula' })]);
  assert.equal(domain.exportReviewsCsv(input), 'id,author,rating,title,status\r\nx,"\'=SUM(1,2)",4,"A ""quote""\nnext",published\r\ny,\'  +calc,4,\'@formula,published');
  assert.equal(domain.exportReviewsCsv([]), 'id,author,rating,title,status');
  for (const prefix of ['-', '@', '\t', '\r']) assert.ok(domain.exportReviewsCsv([review('x', { author: `${prefix}x` })]).includes("'"));
  const html = render(sampleReviews, { filters: { status: 'published' }, pageSize: 2 });
  assert.match(html, /download="reviews.csv"/);
  const link = html.match(/href="(data:text\/csv;charset=utf-8,[^"]+)"/);
  assert.ok(link, 'CSV anchor must expose the complete filtered set');
  const csv = decodeURIComponent(link[1].slice('data:text/csv;charset=utf-8,'.length).replaceAll('&amp;', '&'));
  assert.equal(csv, domain.exportReviewsCsv(domain.selectReviews(sampleReviews, { status: 'published' })));
  assert.ok(csv.includes('r18,'), 'export includes rows beyond first page');
}
if (phase >= 6) {
  const input = freeze([review('a'), review('b', { status: 'pending' })]);
  assert.equal(domain.updateReviewStatus(input, [], 'hidden'), input);
  assert.equal(domain.updateReviewStatus(input, ['missing'], 'hidden'), input);
  assert.equal(domain.updateReviewStatus(input, ['a'], 'published'), input);
  assert.throws(() => domain.updateReviewStatus(input, [], 'unknown'));
  const changed = domain.updateReviewStatus(input, ['b', 'b'], 'published');
  assert.notEqual(changed, input);
  assert.equal(changed[0], input[0]);
  assert.deepEqual(changed[1], { ...input[1], status: 'published' });
  const html = render(input, { selectedIds: ['b'] });
  assert.ok(checkedCheckbox(html, 'Select review by Author b'));
  assert.ok(disabledButton(render(input), 'Publish'));
}
if (phase >= 7) {
  const input = freeze([review('a'), review('b', { reply: 'Thanks' })]);
  assert.equal(domain.updateReviewReply(input, 'missing', 'new'), input);
  assert.equal(domain.updateReviewReply(input, 'b', ' Thanks '), input);
  assert.equal(domain.updateReviewReply(input, 'a', '  '), input);
  const changed = domain.updateReviewReply(input, 'b', '   ');
  assert.equal(changed[0], input[0]);
  assert.equal(Object.hasOwn(changed[1], 'reply'), false);
  assert.equal(domain.updateReviewReply(input, 'a', '😀'.repeat(500))[0].reply, '😀'.repeat(500));
  assert.throws(() => domain.updateReviewReply(input, 'a', '😀'.repeat(501)));
  assert.match(render([review('a', { reply: '<script>alert(1)</script>' })]), /<blockquote[\s\S]*&lt;script&gt;/);
}
if (phase >= 8) {
  assert.deepEqual(domain.highlightReviewText('A+b a+B end', ' a+b '), [
    { text: 'A+b', match: true }, { text: ' ', match: false }, { text: 'a+B', match: true }, { text: ' end', match: false }]);
  assert.deepEqual(domain.highlightReviewText('aaaaa', 'aa'), [
    { text: 'aa', match: true }, { text: 'aa', match: true }, { text: 'a', match: false }]);
  assert.deepEqual(domain.highlightReviewText('', ''), [{ text: '', match: false }]);
  assert.deepEqual(domain.highlightReviewText('Original', ' '), [{ text: 'Original', match: false }]);
  const html = render([review('a', { title: '<img src=x> a+b' })], { filters: { query: 'a+b' } });
  assert.match(html, /<mark[^>]*>a\+b<\/mark>/);
  assert.ok(!html.includes('<img'), 'highlighting must preserve React escaping');
}
if (phase >= 9) {
  const input = freeze([review('a', { title: 'Clear visit', rating: 5 }), review('b', { title: 'CLEAR notes', status: 'pending' }),
    review('c', { title: 'Clear reply', rating: 3 }), review('d', { title: 'Other' })]);
  const view = domain.getReviewView(input, { query: 'clear', status: 'published', sort: 'rating-high' }, 2, 1);
  assert.deepEqual(ids(view.matched), ['a', 'c']);
  assert.equal(view.summary.count, 2);
  assert.equal(view.summary.average, 4);
  assert.deepEqual(ids(view.pagination.items), ['c']);
  const html = render(input, { filters: { query: 'absent' } });
  assert.match(html, /role="status"/);
  assert.match(html, /No matching reviews/);
  assert.match(html, /Clear filters/);
  assert.deepEqual(renderedIds(html), []);
}
if (phase >= 10) {
  const html = render([review('x', { rating: 4 })]);
  assert.match(html, /<form[^>]*aria-label="Review filters"/);
  assert.match(html, /aria-label="4 out of 5 stars"/);
  assert.match(html, /<nav[^>]*aria-label="Review pagination"/);
  assert.match(html, /aria-current="page"/);
  const css = await fs.readFile(path.join(workspace, 'review-workbench.css'), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
}
if (phase >= 11) {
  assert.match(render([], { compact: true }), /<main[^>]*data-density="compact"/);
  assert.match(render([]), /<main[^>]*data-density="comfortable"/);
  const css = await fs.readFile(path.join(workspace, 'review-workbench.css'), 'utf8');
  assert.match(css, /\[data-density=["']?compact["']?\][^{]*\{[^}]*gap:\s*8px/);
}
console.log(JSON.stringify({ phase, independentBehavior: 'passed' }));
