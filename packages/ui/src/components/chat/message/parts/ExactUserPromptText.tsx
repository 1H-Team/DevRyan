import React from 'react';

import type { AgentMentionInfo } from '../types';

type ExactUserPromptTextProps = {
    text: string;
    agentMention?: Pick<AgentMentionInfo, 'name' | 'token'>;
};

const buildMentionUrl = (name: string): string => {
    const encoded = encodeURIComponent(name);
    return `https://opencode.ai/docs/agents/#${encoded}`;
};

const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/g, '\n');

export const ExactUserPromptText: React.FC<ExactUserPromptTextProps> = ({ text, agentMention }) => {
    const normalizedText = normalizeLineEndings(text);
    const token = agentMention?.token;

    if (!token || !normalizedText.includes(token)) {
        return <>{normalizedText}</>;
    }

    const tokenStart = normalizedText.indexOf(token);
    const before = normalizedText.slice(0, tokenStart);
    const after = normalizedText.slice(tokenStart + token.length);

    return (
        <>
            {before}
            <a
                href={buildMentionUrl(agentMention.name)}
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
            >
                {token}
            </a>
            {after}
        </>
    );
};
