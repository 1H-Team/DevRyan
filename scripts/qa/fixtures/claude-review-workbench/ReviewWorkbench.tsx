import './review-workbench.css';
import { selectReviews, summarizeReviews } from './review-domain';
import type { Review, ReviewFilters as Filters } from './review-domain';
import { ReviewFilters } from './ReviewFilters';
import { ReviewSummary } from './ReviewSummary';
import { ReviewList } from './ReviewList';

export interface ReviewWorkbenchProps {
  reviews: readonly Review[];
  filters?: Filters;
  page?: number;
  pageSize?: number;
  selectedIds?: readonly string[];
  compact?: boolean;
}

export function ReviewWorkbench({ reviews, filters = {} }: ReviewWorkbenchProps) {
  const visible = selectReviews(reviews, filters);
  return (
    <main className="review-workbench">
      <header>
        <h1>Review workbench</h1>
        <ReviewFilters filters={filters} />
      </header>
      <ReviewSummary summary={summarizeReviews(visible)} />
      <ReviewList reviews={visible} filters={filters} />
    </main>
  );
}
