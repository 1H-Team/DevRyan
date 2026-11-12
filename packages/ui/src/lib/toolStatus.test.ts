import { describe, expect, test } from 'bun:test'

import { getToolLifecycleState, isFinalToolStatus, normalizeToolStatus } from './toolStatus'

describe('normalizeToolStatus', () => {
  test('returns undefined for every non-string value', () => {
    expect(normalizeToolStatus(undefined)).toBeUndefined()
    expect(normalizeToolStatus(null)).toBeUndefined()
    expect(normalizeToolStatus(0)).toBeUndefined()
    expect(normalizeToolStatus(1)).toBeUndefined()
    expect(normalizeToolStatus(true)).toBeUndefined()
    expect(normalizeToolStatus({ status: 'running' })).toBeUndefined()
    expect(normalizeToolStatus(['running'])).toBeUndefined()
  })

  test('returns undefined when nothing but whitespace and separators remain', () => {
    expect(normalizeToolStatus('')).toBeUndefined()
    expect(normalizeToolStatus('   ')).toBeUndefined()
    expect(normalizeToolStatus('\t\n')).toBeUndefined()
    expect(normalizeToolStatus('_')).toBeUndefined()
    expect(normalizeToolStatus('-_- _')).toBeUndefined()
  })

  test('lowercases and removes every run of whitespace, underscores and hyphens', () => {
    expect(normalizeToolStatus('running')).toBe('running')
    expect(normalizeToolStatus('RUNNING')).toBe('running')
    expect(normalizeToolStatus('  Running  ')).toBe('running')
    expect(normalizeToolStatus('in_progress')).toBe('inprogress')
    expect(normalizeToolStatus('In-Progress')).toBe('inprogress')
    expect(normalizeToolStatus('in   progress')).toBe('inprogress')
    expect(normalizeToolStatus('in _- progress')).toBe('inprogress')
    expect(normalizeToolStatus('TIMED_OUT')).toBe('timedout')
    expect(normalizeToolStatus('_running_')).toBe('running')
  })

  test('treats Unicode whitespace as whitespace and leaves other characters in place', () => {
    expect(normalizeToolStatus('\u00a0running\u00a0')).toBe('running')
    expect(normalizeToolStatus('in\u3000progress')).toBe('inprogress')
    expect(normalizeToolStatus('in\u2003progress')).toBe('inprogress')
    // A zero-width space is not whitespace: it stays and the status is unknown.
    expect(normalizeToolStatus('run\u200bning')).toBe('run\u200bning')
    expect(normalizeToolStatus('run.ning')).toBe('run.ning')
  })

  test('lowercases without a locale, so a dotted capital I becomes i plus a combining dot', () => {
    expect(normalizeToolStatus('FA\u0130LED')).toBe('fai\u0307led')
    expect(normalizeToolStatus('\u00c9TAT')).toBe('\u00e9tat')
  })

  test('keeps surrogate pairs and lone surrogates unchanged', () => {
    expect(normalizeToolStatus('done\ud83d\ude00')).toBe('done\ud83d\ude00')
    expect(normalizeToolStatus('\ud800')).toBe('\ud800')
    expect(normalizeToolStatus('RUN\udc00')).toBe('run\udc00')
  })

  test('normalizes a very long status without truncating it', () => {
    const long = `${'A_'.repeat(5_000)}B`
    expect(normalizeToolStatus(long)).toBe(`${'a'.repeat(5_000)}b`)
  })
})

describe('isFinalToolStatus', () => {
  test('accepts every final status in any case and with separators', () => {
    for (const status of [
      'completed',
      'complete',
      'error',
      'failed',
      'aborted',
      'timeout',
      'timedout',
      'done',
      'cancelled',
      'canceled',
    ]) {
      expect(isFinalToolStatus(status)).toBe(true)
      expect(isFinalToolStatus(status.toUpperCase())).toBe(true)
    }
    expect(isFinalToolStatus(' Timed Out ')).toBe(true)
    expect(isFinalToolStatus('time-out')).toBe(true)
    expect(isFinalToolStatus('can_celled')).toBe(true)
  })

  test('rejects active, unknown, empty and non-string statuses', () => {
    for (const status of ['pending', 'running', 'started', 'in_progress', 'processing', 'executing']) {
      expect(isFinalToolStatus(status)).toBe(false)
    }
    expect(isFinalToolStatus('queued')).toBe(false)
    expect(isFinalToolStatus('success')).toBe(false)
    expect(isFinalToolStatus('completed.')).toBe(false)
    expect(isFinalToolStatus('')).toBe(false)
    expect(isFinalToolStatus('  ')).toBe(false)
    expect(isFinalToolStatus(undefined)).toBe(false)
    expect(isFinalToolStatus(null)).toBe(false)
    expect(isFinalToolStatus(1)).toBe(false)
  })

  test('does not fold a dotted capital I to a plain i', () => {
    expect(isFinalToolStatus('FA\u0130LED')).toBe(false)
    expect(isFinalToolStatus('FAILED')).toBe(true)
  })
})

describe('getToolLifecycleState', () => {
  test('treats a missing state, null and an empty state as unknown and in flight', () => {
    const expected = {
      status: undefined,
      start: undefined,
      end: undefined,
      hasStarted: false,
      hasEnded: false,
      isStatusActive: false,
      isStatusFinal: false,
      isInFlight: true,
      isFinalized: false,
    }
    expect(getToolLifecycleState()).toEqual(expected)
    expect(getToolLifecycleState(undefined)).toEqual(expected)
    expect(getToolLifecycleState(null)).toEqual(expected)
    expect(getToolLifecycleState({})).toEqual(expected)
    expect(getToolLifecycleState({ time: {} })).toEqual(expected)
    expect(getToolLifecycleState({ status: '' })).toEqual(expected)
  })

  test('reports the normalized status', () => {
    expect(getToolLifecycleState({ status: ' In_Progress ' }).status).toBe('inprogress')
    expect(getToolLifecycleState({ status: 7 }).status).toBeUndefined()
  })

  test('an active status without an end is in flight and not finalized', () => {
    for (const status of ['pending', 'running', 'started', 'in progress', 'processing', 'executing']) {
      const state = getToolLifecycleState({ status, time: { start: 10 } })
      expect(state.isStatusActive).toBe(true)
      expect(state.isStatusFinal).toBe(false)
      expect(state.isInFlight).toBe(true)
      expect(state.isFinalized).toBe(false)
      expect(state.hasStarted).toBe(true)
      expect(state.hasEnded).toBe(false)
      expect(state.start).toBe(10)
      expect(state.end).toBeUndefined()
    }
  })

  test('an active status with a valid end is finalized and not in flight', () => {
    expect(getToolLifecycleState({ status: 'running', time: { start: 10, end: 20 } })).toEqual({
      status: 'running',
      start: 10,
      end: 20,
      hasStarted: true,
      hasEnded: true,
      isStatusActive: true,
      isStatusFinal: false,
      isInFlight: false,
      isFinalized: true,
    })
  })

  test('a final status is finalized and not in flight even without timestamps', () => {
    expect(getToolLifecycleState({ status: 'completed' })).toEqual({
      status: 'completed',
      start: undefined,
      end: undefined,
      hasStarted: false,
      hasEnded: false,
      isStatusActive: false,
      isStatusFinal: true,
      isInFlight: false,
      isFinalized: true,
    })
  })

  test('an unknown status is in flight until an end arrives', () => {
    const open = getToolLifecycleState({ status: 'queued', time: { start: 1 } })
    expect(open.isStatusActive).toBe(false)
    expect(open.isStatusFinal).toBe(false)
    expect(open.isInFlight).toBe(true)
    expect(open.isFinalized).toBe(false)

    const ended = getToolLifecycleState({ status: 'queued', time: { start: 1, end: 2 } })
    expect(ended.isInFlight).toBe(false)
    expect(ended.isFinalized).toBe(true)
  })

  test('an end before the start is ignored and also blocks finalization by a final status', () => {
    expect(getToolLifecycleState({ status: 'completed', time: { start: 20, end: 10 } })).toEqual({
      status: 'completed',
      start: 20,
      end: undefined,
      hasStarted: true,
      hasEnded: false,
      isStatusActive: false,
      isStatusFinal: true,
      isInFlight: false,
      isFinalized: false,
    })

    const running = getToolLifecycleState({ status: 'running', time: { start: 20, end: 19 } })
    expect(running.hasEnded).toBe(false)
    expect(running.end).toBeUndefined()
    expect(running.isInFlight).toBe(true)
    expect(running.isFinalized).toBe(false)
  })

  test('an end equal to the start is a valid end', () => {
    const state = getToolLifecycleState({ status: 'running', time: { start: 5, end: 5 } })
    expect(state.hasEnded).toBe(true)
    expect(state.end).toBe(5)
    expect(state.isInFlight).toBe(false)
    expect(state.isFinalized).toBe(true)
  })

  test('an end without a start is always valid, zero and negative values included', () => {
    const zero = getToolLifecycleState({ status: 'running', time: { end: 0 } })
    expect(zero.hasEnded).toBe(true)
    expect(zero.end).toBe(0)
    expect(zero.hasStarted).toBe(false)
    expect(zero.isInFlight).toBe(false)
    expect(zero.isFinalized).toBe(true)

    const negative = getToolLifecycleState({ time: { start: -5, end: -1 } })
    expect(negative.start).toBe(-5)
    expect(negative.end).toBe(-1)
    expect(negative.hasEnded).toBe(true)
    expect(negative.isInFlight).toBe(false)
    expect(negative.isFinalized).toBe(true)
  })

  test('only finite numbers are timestamps', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, true]) {
      const state = getToolLifecycleState({ status: 'running', time: { start: value, end: value } })
      expect(state.start).toBeUndefined()
      expect(state.end).toBeUndefined()
      expect(state.hasStarted).toBe(false)
      expect(state.hasEnded).toBe(false)
      expect(state.isInFlight).toBe(true)
    }
    const large = getToolLifecycleState({ time: { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_VALUE } })
    expect(large.start).toBe(Number.MAX_SAFE_INTEGER)
    expect(large.end).toBe(Number.MAX_VALUE)
    expect(large.hasEnded).toBe(true)
  })

  test('accepts fractional timestamps', () => {
    const state = getToolLifecycleState({ status: 'running', time: { start: 1.5, end: 2.5 } })
    expect(state.start).toBe(1.5)
    expect(state.end).toBe(2.5)
    expect(state.hasStarted).toBe(true)
    expect(state.hasEnded).toBe(true)
    expect(state.isInFlight).toBe(false)
    expect(getToolLifecycleState({ time: { start: 2.5, end: 2.25 } }).hasEnded).toBe(false)
  })

  test('an invalid start does not make a valid end invalid', () => {
    const state = getToolLifecycleState({ status: 'running', time: { start: Number.NaN, end: 1 } })
    expect(state.hasStarted).toBe(false)
    expect(state.hasEnded).toBe(true)
    expect(state.isFinalized).toBe(true)
  })

  test('keeps negative zero as the start timestamp', () => {
    expect(getToolLifecycleState({ time: { start: -0 } }).start).toBe(-0)
  })

  test('returns a new object on every call', () => {
    const input = { status: 'running', time: { start: 1 } }
    const first = getToolLifecycleState(input)
    const second = getToolLifecycleState(input)
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
    expect(input).toEqual({ status: 'running', time: { start: 1 } })
  })
})
