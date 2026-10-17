// Hands the first message typed on the chat home to the new thread page, which sends it.
export interface PendingFirstMessage {
  text: string;
  files: File[];
}

const pendingFirstMessages = new Map<string, PendingFirstMessage>();

export function setPendingFirstMessage(caseId: string, message: PendingFirstMessage) {
  pendingFirstMessages.set(caseId, message);
}

export function takePendingFirstMessage(caseId: string): PendingFirstMessage | undefined {
  const message = pendingFirstMessages.get(caseId);
  pendingFirstMessages.delete(caseId);
  return message;
}
