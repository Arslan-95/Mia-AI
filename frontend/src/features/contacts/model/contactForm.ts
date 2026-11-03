export type ContactForm = {
  turnId: string;
  operation: 'create' | 'rename';
  name: string | null;
  identifier: string | null;
  status: 'editing' | 'saving' | 'saved' | 'failed' | 'interrupted' | 'clarification';
};

/** Full snapshots prevent fields from a previous person leaking into a new form. */
export function contactFormSnapshot(payload: Record<string, unknown>): ContactForm | null | undefined {
  if (payload.status === 'dismissed') return null;
  if (typeof payload.turnId !== 'string' || !['create', 'rename'].includes(String(payload.operation)) ||
    !['editing', 'saving', 'saved', 'failed', 'clarification'].includes(String(payload.status))) return undefined;
  if (!(payload.name === null || typeof payload.name === 'string' && payload.name.length <= 80) ||
    !(payload.identifier === null || typeof payload.identifier === 'string' && payload.identifier.length <= 100)) return undefined;
  return { turnId: payload.turnId, operation: payload.operation as ContactForm['operation'],
    name: payload.name as string | null, identifier: payload.identifier as string | null, status: payload.status as ContactForm['status'] };
}

export const contactFormStatus: Record<ContactForm['status'], string> = {
  editing: 'Mia is filling in the details', saving: 'Saving contact…', saved: 'Contact saved',
  failed: 'Contact could not be saved', interrupted: 'Contact task interrupted',
  clarification: 'Waiting for clarification',
};
