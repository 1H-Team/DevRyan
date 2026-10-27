import fs from 'node:fs';
import path from 'node:path';

export const selectBrowserPartitionIdentity = ({ userDataDirectory, readDirectory = fs.readdirSync } = {}) => {
  let oldPartitions = false;
  try {
    oldPartitions = readDirectory(path.join(userDataDirectory, 'Partitions')).some(name =>
      typeof name === 'string' && name.startsWith('openchamber-browser'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const legacy = oldPartitions || userDataDirectory.endsWith(path.join('@openchamber', 'electron'));
  const base = legacy ? 'openchamber-browser' : 'devryan-browser';
  return Object.freeze({ shared: `persist:${base}`, manualPrefix: `persist:${base}-user-`,
    agentPrefix: `persist:${base}-agent-`, legacy });
};
