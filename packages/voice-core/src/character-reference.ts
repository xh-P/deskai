export interface CharacterReference {
  id: string;
  source: string;
  locator: string;
  text: string;
  distance: number;
}

export interface CharacterLookup {
  status: 'disabled' | 'no-corpus' | 'unavailable' | 'miss' | 'hit';
  hits: CharacterReference[];
  nearestDistance?: number;
  elapsedMs?: number;
  code?: string;
}

export type CharacterLookupSummary = Omit<CharacterLookup, 'hits'> & { hits: Omit<CharacterReference, 'text'>[] };
