

const AGENT_COLOR_PALETTE = [
  { var: '--status-success', class: 'agent-success' },
  { var: '--syntax-keyword', class: 'agent-keyword' },
  { var: '--syntax-type', class: 'agent-type' },
  { var: '--syntax-function', class: 'agent-function' },
  { var: '--syntax-number', class: 'agent-number' },
  { var: '--status-info', class: 'agent-info' },
  { var: '--status-warning', class: 'agent-warning' },
  { var: '--syntax-variable', class: 'agent-variable' },
];

const FIXED_AGENT_ICON_COLORS: Readonly<Record<string, { readonly var: string }>> = {
  designer: { var: '--agent-icon-designer-color' },
  fixer: { var: '--agent-icon-fixer-color' },
  explorer: { var: '--agent-icon-explorer-color' },
  librarian: { var: '--agent-icon-librarian-color' },
  oracle: { var: '--agent-icon-oracle-color' },
};

export function getAgentColor(agentName: string | undefined) {
  if (!agentName) {
    return AGENT_COLOR_PALETTE[0];
  }

  const normalizedAgentName = agentName.trim().toLowerCase();

  if (normalizedAgentName === 'build' || normalizedAgentName === 'builder') {
    return AGENT_COLOR_PALETTE[0];
  }

  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    const char = agentName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const paletteIndex = 1 + (Math.abs(hash) % (AGENT_COLOR_PALETTE.length - 1));
  return AGENT_COLOR_PALETTE[paletteIndex];
}

export function getAgentIconColor(agentName: string | undefined) {
  const normalizedAgentName = agentName?.trim().toLowerCase();
  if (normalizedAgentName) {
    const fixedColor = FIXED_AGENT_ICON_COLORS[normalizedAgentName];
    if (fixedColor) {
      return fixedColor;
    }
  }

  return getAgentColor(agentName);
}

export function getAgentColorPalette() {
  return AGENT_COLOR_PALETTE;
}
