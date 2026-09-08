export type ReviewStatus = 'pending' | 'published' | 'hidden';
export type ReviewSort = 'newest' | 'oldest' | 'rating-high' | 'rating-low' | 'helpful';
export interface Review {
  id: string;
  author: string;
  title: string;
  body: string;
  rating: number;
  createdAt: string;
  verified: boolean;
  status: ReviewStatus;
  helpfulVotes: number;
  reply?: string;
}
export interface ReviewFilters {
  query?: string;
  minRating?: number;
  verifiedOnly?: boolean;
  status?: ReviewStatus | 'all';
  sort?: ReviewSort;
}
export interface ReviewSummary {
  count: number;
  average: number;
  verifiedCount: number;
  histogram: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function selectReviews(reviews: readonly Review[], filters: ReviewFilters = {}): Review[] {
  void filters;
  return [...reviews];
}

export function summarizeReviews(reviews: readonly Review[]): ReviewSummary {
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return {
    count: reviews.length,
    average: reviews.length ? total / reviews.length : 0,
    verifiedCount: reviews.filter(review => review.verified).length,
    histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
}
