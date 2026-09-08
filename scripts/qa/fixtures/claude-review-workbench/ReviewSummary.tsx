import type { ReviewSummary as Summary } from './review-domain';

export function ReviewSummary({ summary }: { summary: Summary }) {
  return (
    <section className="review-summary" aria-label="Review summary">
      <strong>{summary.average.toFixed(1)}</strong>
      <span>{summary.count} reviews</span>
    </section>
  );
}
