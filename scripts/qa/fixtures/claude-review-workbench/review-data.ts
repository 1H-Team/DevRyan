import type { Review } from './review-domain';

export const sampleReviews: Review[] = [
  { id: 'r1', author: 'Maya', title: 'Thoughtful service', body: 'A calm, helpful visit.', rating: 5, createdAt: '2026-08-18T10:00:00Z', verified: true, status: 'published', helpfulVotes: 8 },
  { id: 'r2', author: 'José', title: 'Clear instructions', body: 'The follow-up email was clear.', rating: 4, createdAt: '2026-08-17T10:00:00Z', verified: true, status: 'pending', helpfulVotes: 2 },
  { id: 'r3', author: 'Lin', title: 'A long wait', body: 'The team was helpful, but late.', rating: 2, createdAt: '2026-08-16T10:00:00Z', verified: false, status: 'published', helpfulVotes: 4 },
  { id: 'r4', author: 'Amir', title: 'Needs a reply', body: 'I would like a call about scheduling.', rating: 3, createdAt: '2026-08-15T10:00:00Z', verified: true, status: 'pending', helpfulVotes: 1 },
  { id: 'r5', author: 'Zoë', title: 'Duplicate submission', body: 'This was sent twice.', rating: 1, createdAt: '2026-08-14T10:00:00Z', verified: false, status: 'hidden', helpfulVotes: 0 },
  { id: 'r6', author: 'Nora', title: 'Easy booking', body: 'The online form worked well.', rating: 5, createdAt: '2026-08-13T10:00:00Z', verified: true, status: 'published', helpfulVotes: 6 },
  { id: 'r7', author: 'Omar', title: 'Friendly staff', body: 'Everyone took time to listen.', rating: 4, createdAt: '2026-08-12T10:00:00Z', verified: false, status: 'published', helpfulVotes: 3 },
  { id: 'r8', author: 'Sofia', title: 'A useful explanation', body: 'Clear notes and a helpful summary.', rating: 5, createdAt: '2026-08-11T10:00:00Z', verified: true, status: 'published', helpfulVotes: 9 },
  { id: 'r9', author: 'Theo', title: 'A billing question', body: 'The receipt could be clearer.', rating: 3, createdAt: '2026-08-10T10:00:00Z', verified: true, status: 'pending', helpfulVotes: 1 },
  { id: 'r10', author: 'Mina', title: 'Wrong location', body: 'This review belongs to another office.', rating: 2, createdAt: '2026-08-09T10:00:00Z', verified: false, status: 'hidden', helpfulVotes: 0 },
  { id: 'r11', author: 'Arun', title: 'Quick response', body: 'The team answered my question quickly.', rating: 5, createdAt: '2026-08-08T10:00:00Z', verified: true, status: 'published', helpfulVotes: 7 },
  { id: 'r12', author: 'Léa', title: 'Good follow-up', body: 'The call helped me plan the next step.', rating: 4, createdAt: '2026-08-07T10:00:00Z', verified: true, status: 'published', helpfulVotes: 5 },
  { id: 'r13', author: 'Eli', title: 'Room to improve', body: 'The waiting room was noisy.', rating: 2, createdAt: '2026-08-06T10:00:00Z', verified: false, status: 'pending', helpfulVotes: 2 },
  { id: 'r14', author: 'Ada', title: 'A reliable team', body: 'I appreciated the clear directions.', rating: 5, createdAt: '2026-08-05T10:00:00Z', verified: true, status: 'published', helpfulVotes: 10 },
  { id: 'r15', author: 'Hugo', title: 'A small delay', body: 'The appointment started ten minutes late.', rating: 3, createdAt: '2026-08-04T10:00:00Z', verified: true, status: 'published', helpfulVotes: 1 },
  { id: 'r16', author: 'Ines', title: 'Helpful reminders', body: 'The reminder included all the right details.', rating: 4, createdAt: '2026-08-03T10:00:00Z', verified: false, status: 'published', helpfulVotes: 4 },
  { id: 'r17', author: 'Ben', title: 'Spam', body: 'Unrelated promotional submission.', rating: 1, createdAt: '2026-08-02T10:00:00Z', verified: false, status: 'hidden', helpfulVotes: 0 },
  { id: 'r18', author: 'Raya', title: 'Simple and calm', body: 'The form and instructions were straightforward.', rating: 5, createdAt: '2026-08-01T10:00:00Z', verified: true, status: 'published', helpfulVotes: 8 },
];
