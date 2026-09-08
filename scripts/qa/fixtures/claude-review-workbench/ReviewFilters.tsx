import type { ReviewFilters as Filters } from './review-domain';

export function ReviewFilters({ filters }: { filters: Filters }) {
  return (
    <div className="review-toolbar">
      <label>
        Search reviews
        <input aria-label="Search reviews" value={filters.query ?? ''} readOnly />
      </label>
    </div>
  );
}
