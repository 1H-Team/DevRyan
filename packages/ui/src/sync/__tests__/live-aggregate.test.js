import { describe, expect, it } from 'bun:test'

import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from '../live-aggregate.ts'

const session = (id, directory, updated, extra = {}) => ({
  id,
  title: `${id}-title`,
  time: { created: updated - 1, updated, archived: undefined },
  directory,
  ...extra,
})

describe('live aggregate', () => {
  it('exposes the generated title from the freshest live session snapshot', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10, { title: 'Untitled Session' })],
        session_status: {},
      },
      {
        session: [session('ses-1', '/a', 25, { title: 'Fix OpenAI session titles' }), session('ses-2', '/b', 20)],
        session_status: {},
      },
    ]

    const sessions = aggregateLiveSessions(states)
    expect(sessions.map((item) => `${item.id}:${item.title}`)).toEqual([
      'ses-1:Fix OpenAI session titles',
      'ses-2:ses-2-title',
    ])
    expect(findLiveSession(states, 'ses-1')?.title).toBe('Fix OpenAI session titles')
  })

  it('prefers busy/retry statuses over stale idle snapshots', () => {
    const states = [
      {
        session: [],
        session_status: {
          'ses-1': { type: 'idle' },
          'ses-2': { type: 'idle' },
        },
      },
      {
        session: [],
        session_status: {
          'ses-1': { type: 'busy' },
          'ses-2': { type: 'retry', message: 'retrying' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('busy')
    expect(statuses['ses-2']?.type).toBe('retry')
    expect(findLiveSessionStatus(states, 'ses-2')?.type).toBe('retry')
  })

  it('lets a fresher idle snapshot override a stale busy status', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10)],
        session_status: {
          'ses-1': { type: 'busy' },
        },
      },
      {
        session: [session('ses-1', '/a', 30)],
        session_status: {
          'ses-1': { type: 'idle' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('idle')
    expect(findLiveSessionStatus(states, 'ses-1')?.type).toBe('idle')
  })

  it('detects retry metadata changes in status maps', () => {
    const retryStatus = { type: 'retry', message: 'retrying|server|message', attempt: 1, next: 100 }

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus } },
    )).toBe(true)

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus, attempt: 2, next: 200 } },
    )).toBe(false)
  })

  it('detects session summary-only changes in session lists', () => {
    const base = session('ses-1', '/a', 10, { summary: { additions: 1, deletions: 2 } })

    expect(areSessionListsEquivalent(
      [base],
      [{ ...base, summary: { additions: 3, deletions: 2 } }],
    )).toBe(false)

    expect(areSessionListsEquivalent(
      [base],
      [{ ...base, summary: { additions: 1, deletions: 2 } }],
    )).toBe(true)
  })
})

describe('live aggregate: ties of updated times', () => {
  it('takes the session from the later state when two states hold equal updated times', () => {
    const early = session('ses-1', '/a', 10, { title: 'from the first state' })
    const late = session('ses-1', '/a', 10, { title: 'from the second state' })
    const states = [
      { session: [early], session_status: {} },
      { session: [late], session_status: {} },
    ]

    expect(aggregateLiveSessions(states)[0]).toBe(late)
    expect(findLiveSession(states, 'ses-1')).toBe(late)
  })

  it('keeps the earlier state when the later one is one millisecond older, and takes the later one when it is one newer', () => {
    const base = session('ses-1', '/a', 10)
    const older = session('ses-1', '/a', 9)
    const newer = session('ses-1', '/a', 11)

    expect(aggregateLiveSessions([{ session: [base], session_status: {} }, { session: [older], session_status: {} }])[0]).toBe(base)
    expect(aggregateLiveSessions([{ session: [base], session_status: {} }, { session: [newer], session_status: {} }])[0]).toBe(newer)
  })

  it('ties a missing updated time with an equal created time, and a session with neither at zero', () => {
    const createdOnly = { id: 'ses-1', title: 'created only', time: { created: 10 } }
    const updated = session('ses-1', '/a', 10)
    expect(aggregateLiveSessions([{ session: [updated], session_status: {} }, { session: [createdOnly], session_status: {} }])[0]).toBe(createdOnly)

    const timeless = { id: 'ses-2', title: 'timeless' }
    const zero = { id: 'ses-2', title: 'zero', time: { created: 0, updated: 0 } }
    expect(aggregateLiveSessions([{ session: [zero], session_status: {} }, { session: [timeless], session_status: {} }])[0]).toBe(timeless)
  })

  it('takes the later state on a tie of updated times and status priority, and the higher priority otherwise', () => {
    const first = { type: 'busy' }
    const second = { type: 'busy' }
    const states = [
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': first } },
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': second } },
    ]
    expect(aggregateLiveSessionStatuses(states)['ses-1']).toBe(second)
    expect(findLiveSessionStatus(states, 'ses-1')).toBe(second)

    const retry = { type: 'retry', attempt: 1, message: 'm', next: 1 }
    const idle = { type: 'idle' }
    const mixed = [
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': retry } },
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': idle } },
    ]
    expect(aggregateLiveSessionStatuses(mixed)['ses-1']).toBe(retry)
  })
})

describe('live aggregate: status maps with undefined members', () => {
  it('treats a key whose value is undefined on both sides as equivalent', () => {
    expect(areStatusMapsEquivalent({ 'ses-1': undefined }, { 'ses-1': undefined })).toBe(true)
    expect(areStatusMapsEquivalent(
      { 'ses-1': undefined, 'ses-2': { type: 'idle' } },
      { 'ses-1': undefined, 'ses-2': { type: 'idle' } },
    )).toBe(true)
  })

  it('treats undefined and a status as different, in either direction', () => {
    expect(areStatusMapsEquivalent({ 'ses-1': undefined }, { 'ses-1': { type: 'idle' } })).toBe(false)
    expect(areStatusMapsEquivalent({ 'ses-1': { type: 'idle' } }, { 'ses-1': undefined })).toBe(false)
  })

  it('treats an undefined member and a missing key as different when the key counts match', () => {
    expect(areStatusMapsEquivalent({ 'ses-1': undefined }, { 'ses-2': undefined })).toBe(false)
    expect(areStatusMapsEquivalent({ 'ses-1': undefined }, {})).toBe(false)
  })

  it('finds a key inherited from Object.prototype, so an undefined status under such a key equals any other one-key map', () => {
    // `in` also sees prototype members: `constructor` is found on the right, and the Object function reads as no status.
    expect(areStatusMapsEquivalent({ constructor: undefined }, { 'ses-1': { type: 'idle' } })).toBe(true)
    expect(areStatusMapsEquivalent({ constructor: { type: 'busy' } }, { 'ses-1': { type: 'idle' } })).toBe(false)
  })
})

describe('live aggregate: status priority and key counts', () => {
  it('prefers retry over busy at equal session times, in either state order', () => {
    const retry = { type: 'retry', attempt: 1, message: 'm', next: 1 }
    const busy = { type: 'busy' }
    const first = [
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': retry } },
      { session: [session('ses-1', '/a', 10)], session_status: { 'ses-1': busy } },
    ]
    expect(aggregateLiveSessionStatuses(first)['ses-1']).toBe(retry)
    expect(findLiveSessionStatus(first, 'ses-1')).toBe(retry)
    expect(aggregateLiveSessionStatuses([...first].reverse())['ses-1']).toBe(retry)
  })

  it('treats an empty map and a one-key map as different in either direction', () => {
    expect(areStatusMapsEquivalent({}, { 'ses-1': { type: 'busy' } })).toBe(false)
    expect(areStatusMapsEquivalent({ 'ses-1': { type: 'busy' } }, {})).toBe(false)
  })
})
