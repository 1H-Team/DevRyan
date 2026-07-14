import React from 'react';

export type AgentChangeRequest = {
  sessionId: string | null;
  currentAgentName: string | null | undefined;
  nextAgentName: string;
  commit: () => void;
};

export type BuilderSendRequest = {
  sessionId: string | null;
  agentName: string | null | undefined;
};

export type AgentHandoffGuardValue = {
  requestAgentChange: (request: AgentChangeRequest) => Promise<void>;
  guardBuilderSend: (request: BuilderSendRequest) => Promise<boolean>;
};

export const AgentHandoffGuardContext = React.createContext<AgentHandoffGuardValue | null>(null);

let queuedBuilderSendGuard: AgentHandoffGuardValue['guardBuilderSend'] | null = null;

export const registerQueuedBuilderSendGuard = (
  guard: AgentHandoffGuardValue['guardBuilderSend'],
) => {
  queuedBuilderSendGuard = guard;
  return () => {
    if (queuedBuilderSendGuard === guard) queuedBuilderSendGuard = null;
  };
};

export const guardQueuedBuilderSend = async (request: BuilderSendRequest) => {
  if ((request.agentName?.trim().toLowerCase() ?? '') !== 'builder') return true;
  if (!queuedBuilderSendGuard) return false;
  return await queuedBuilderSendGuard(request);
};

export const useAgentHandoffGuard = () => {
  const value = React.useContext(AgentHandoffGuardContext);
  if (!value) {
    throw new Error('useAgentHandoffGuard must be used within AgentHandoffGuardProvider');
  }
  return value;
};
