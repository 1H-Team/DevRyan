import type { Review, ReviewFilters } from './review-domain';

export function ReviewList({ reviews }: {
  reviews: readonly Review[];
  filters?: ReviewFilters;
  selectedIds?: readonly string[];
}) {
  return (
    <div className="review-list">
      {reviews.map(review => (
        <article className="review-card" key={review.id} data-review-id={review.id}>
          <h3>{review.title}</h3>
          <span>{review.author}</span>
          <span>{review.rating} stars</span>
          <p>{review.body}</p>
        </article>
      ))}
    </div>
  );
}
