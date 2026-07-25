export type ActivityKind = 'call' | 'meeting' | 'email' | 'task' | 'comment' | 'other';

/** A touchpoint on a CRM record: call, meeting, email, task or timeline note. */
export interface Activity {
  id: number;
  kind: ActivityKind;
  subject: string;
  completed: boolean;
  direction: 'incoming' | 'outgoing' | null;
  ownerType: 'company' | 'contact' | 'deal' | 'lead' | null;
  ownerId: number | null;
  responsibleId: number | null;
  createdAt: string | null;
  deadlineAt: string | null;
}

/** A planned future step — an open activity or an open task. */
export interface NextAction {
  source: 'activity' | 'task';
  id: number;
  title: string;
  dueAt: string | null;
  responsibleId: number | null;
  overdue: boolean;
}

export const OWNER_TYPE_ID: Record<'lead' | 'deal' | 'contact' | 'company', number> = {
  lead: 1,
  deal: 2,
  contact: 3,
  company: 4,
};

export function ownerTypeFromId(id: number | string | null | undefined): Activity['ownerType'] {
  switch (Number(id)) {
    case 1:
      return 'lead';
    case 2:
      return 'deal';
    case 3:
      return 'contact';
    case 4:
      return 'company';
    default:
      return null;
  }
}

/** crm.activity TYPE_ID: 1 meeting, 2 call, 3 task, 4 email, 6 custom. */
export function activityKindFromTypeId(typeId: number | string | null | undefined): ActivityKind {
  switch (Number(typeId)) {
    case 1:
      return 'meeting';
    case 2:
      return 'call';
    case 3:
      return 'task';
    case 4:
      return 'email';
    case 6:
      return 'comment';
    default:
      return 'other';
  }
}

export function isOverdue(dueAt: string | null, now: Date): boolean {
  if (!dueAt) return false;
  const t = Date.parse(dueAt);
  return !Number.isNaN(t) && t < now.getTime();
}
