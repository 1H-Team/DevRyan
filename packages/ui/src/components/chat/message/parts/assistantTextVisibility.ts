export const shouldRenderAssistantText = (input: {
    displayTextContent: string;
    isFinalized: boolean;
}): boolean => {
    if (!input.isFinalized && input.displayTextContent.trim().length === 0) {
        return false;
    }
    return input.displayTextContent.trim().length > 0;
};
