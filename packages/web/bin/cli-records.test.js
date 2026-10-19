import { describe, expect, it } from 'vitest';
import { daemonRecordPaths, daemonRecordPort, daemonLogPath } from './cli-records.js';

describe('CLI daemon identity compatibility', () => {
  it('writes canonical names first while retaining matching legacy pairs', () => {
    expect(daemonRecordPaths('/owned/run', 3000)).toEqual([
      { pid: '/owned/run/devryan-3000.pid', instance: '/owned/run/devryan-3000.json' },
      { pid: '/owned/run/openchamber-3000.pid', instance: '/owned/run/openchamber-3000.json' },
    ]);
  });
  it('discovers exact canonical and legacy record basenames, rejecting malformed ports', () => {
    expect(daemonRecordPort('devryan-3000.pid')).toBe(3000);
    expect(daemonRecordPort('openchamber-3000.pid')).toBe(3000);
    for (const value of ['other-3000.pid', 'devryan-0.pid', 'devryan-65536.pid', 'devryan-3x.pid', '../devryan-3000.pid']) {
      expect(daemonRecordPort(value)).toBeNull();
    }
  });
  it('reads an active legacy daemon log even when a prior canonical log exists', () => {
    const exists = () => true;
    expect(daemonLogPath('/owned/logs', 3000, { exists, recordPath: '/owned/run/openchamber-3000.pid' }))
      .toBe('/owned/logs/openchamber-3000.log');
    expect(daemonLogPath('/owned/logs', 3000, { exists, recordPath: '/owned/run/devryan-3000.pid' }))
      .toBe('/owned/logs/devryan-3000.log');
    expect(daemonLogPath('/owned/logs', 3000)).toBe('/owned/logs/devryan-3000.log');
  });
});
