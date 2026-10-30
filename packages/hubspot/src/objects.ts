import type { ObjectType } from '@cs-agent/core';

/** HubSpot object-type path segment for a port object name. */
export function objectPath(object: ObjectType): string {
  switch (object) {
    case 'company':
      return 'companies';
    case 'contact':
      return 'contacts';
    case 'deal':
      return 'deals';
    case 'ticket':
      return 'tickets';
    case 'note':
      return 'notes';
    case 'email':
      return 'emails';
    case 'meeting':
      return 'meetings';
    case 'call':
      return 'calls';
    case 'task':
      return 'tasks';
  }
}

export function pipelinePath(object: 'deal' | 'ticket'): string {
  return object === 'deal' ? 'deals' : 'tickets';
}

export const BATCH_SIZE = 100;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages;
}
