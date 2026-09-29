import { describe, expect, it } from 'vitest';
import { retrievalHint, termOverlap, withRetrievalHint } from './retrieval-hints';

const good = { results: [{ title: 'Edge segmentation', content: "Only the merge policy marked 'Active-On-Edge' is used for edge segmentation." }] };

describe('retrievalHint', () => {
  it('says nothing about on-topic results', () => {
    expect(retrievalHint('search_adobe_knowledge', 'Which merge policy is required for edge segmentation?', good)).toBeUndefined();
  });

  it('asks for a rewritten query when nothing came back', () => {
    expect(retrievalHint('search_adobe_knowledge', 'edge merge policy', { results: [] })).toMatch(/found nothing.*rewritten query/);
  });

  it('flags results that share almost none of the query terms', () => {
    const offTopic = { results: [{ title: 'Launch data elements', content: 'Data elements map values from the data layer.' }] };
    expect(retrievalHint('search_adobe_knowledge', 'Which merge policy is required for edge segmentation?', offTopic)).toMatch(/off-topic/);
  });

  it('does nothing without a query', () => {
    expect(retrievalHint('search_adobe_knowledge', undefined, { results: [] })).toBeUndefined();
  });
});

describe('termOverlap', () => {
  it('ignores stopwords and counts distinctive terms found', () => {
    expect(termOverlap('What is the merge policy?', good)).toBe(1);
    expect(termOverlap('the and of', good)).toBe(1);
  });
});

describe('withRetrievalHint', () => {
  it('adds the hint to an object result without losing fields, and leaves good results alone', () => {
    const out = withRetrievalHint('search_adobe_knowledge', 'edge merge policy', { results: [], total: 0 }) as Record<string, unknown>;
    expect(out._retrievalHint).toBeTypeOf('string');
    expect(out.total).toBe(0);
    expect(withRetrievalHint('search_adobe_knowledge', 'edge segmentation merge policy', good)).toBe(good);
  });
});
