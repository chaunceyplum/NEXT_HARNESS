import { describe, expect, it } from 'vitest';
import { validateCommitFiles } from './commit-validation';

describe('validateCommitFiles', () => {
  it('accepts a well-formed set of files with no errors', () => {
    const files = JSON.stringify({
      'src/foo.ts': 'export const x: number = 1;',
      'package.json': '{"name": "x"}',
      'README.md': '# Hello\n\nNo parser for markdown, so this always passes.',
    });
    expect(validateCommitFiles(files)).toEqual([]);
  });

  it('rejects a files payload that is not valid JSON', () => {
    const errors = validateCommitFiles('{not json');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not valid JSON/);
  });

  it('rejects a files payload that is not a JSON object', () => {
    expect(validateCommitFiles('["a.ts"]')).toEqual([
      '"files" must be a JSON object of { path: content }',
    ]);
    expect(validateCommitFiles('"just a string"')).toEqual([
      '"files" must be a JSON object of { path: content }',
    ]);
  });

  it('flags a non-string content value for a given path', () => {
    const files = JSON.stringify({ 'a.ts': 123 });
    const errors = validateCommitFiles(files);
    expect(errors).toEqual(['a.ts: content must be a string']);
  });

  it('flags invalid JSON content for a .json file', () => {
    const files = JSON.stringify({ 'config.json': '{ "a": ' });
    const errors = validateCommitFiles(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^config\.json: invalid JSON/);
  });

  it('flags a genuine syntax error in a .ts file', () => {
    const files = JSON.stringify({ 'broken.ts': 'export const x = ;' });
    const errors = validateCommitFiles(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^broken\.ts: syntax error/);
  });

  it('flags a genuine syntax error in a .tsx file, including JSX', () => {
    const files = JSON.stringify({ 'Broken.tsx': 'export default function() { return <div> }' });
    const errors = validateCommitFiles(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Broken\.tsx: syntax error/);
  });

  it('does not attempt to parse extensions it has no checker for', () => {
    const files = JSON.stringify({ 'notes.txt': 'this is not { valid ts or json at all [[[' });
    expect(validateCommitFiles(files)).toEqual([]);
  });

  it('reports one error per broken file when several files are given at once', () => {
    const files = JSON.stringify({
      'good.ts': 'export const ok = true;',
      'bad.ts': 'export const x = ;',
      'bad.json': '{not json}',
    });
    const errors = validateCommitFiles(files);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.startsWith('bad.ts:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('bad.json:'))).toBe(true);
  });
});
