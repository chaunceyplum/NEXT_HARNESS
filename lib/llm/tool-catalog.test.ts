import { describe, expect, it } from 'vitest';
import { isAdobeScoped, isNonRetryableError, pickRagTool, summarizeArgsForRagQuery } from './tool-catalog';

describe('isAdobeScoped', () => {
  it('keeps Adobe and other in-scope tools', () => {
    for (const name of ['adobe_create_schema', 'cja_list_projects', 'reactor_get_library', 'execute_sql', 'msb_github_commit_code']) {
      expect(isAdobeScoped(name)).toBe(true);
    }
  });

  it('excludes AWS/Databricks/Snowflake-prefixed tools', () => {
    for (const name of ['aws_recommend_services', 'databricks_run_job', 'snowflake_query']) {
      expect(isAdobeScoped(name)).toBe(false);
    }
  });

  it('excludes the named non-Adobe knowledge/search tools even without a matching prefix', () => {
    for (const name of ['search_aws_knowledge', 'search_data_eng_knowledge', 'search_all_agents', 'data_sql_pattern']) {
      expect(isAdobeScoped(name)).toBe(false);
    }
  });
});

describe('isNonRetryableError', () => {
  it('treats 401/403 and known permission phrasing as permanent', () => {
    expect(isNonRetryableError('403: {"errorCode":"insufficient_access"}')).toBe(true);
    expect(isNonRetryableError('HTTP 401 Unauthorized')).toBe(true);
    expect(isNonRetryableError('Request forbidden by policy')).toBe(true);
    expect(isNonRetryableError('permission denied for resource X')).toBe(true);
  });

  it('treats an unrelated failure as retryable', () => {
    expect(isNonRetryableError('ETIMEDOUT: connection timed out')).toBe(false);
    expect(isNonRetryableError('500 Internal Server Error')).toBe(false);
    expect(isNonRetryableError('validation error: "name" is required')).toBe(false);
  });
});

describe('summarizeArgsForRagQuery', () => {
  it('passes small argument sets through untouched', () => {
    const args = { name: 'test-schema', sandbox: 'prod' };
    expect(summarizeArgsForRagQuery(args)).toBe(JSON.stringify(args));
  });

  it('truncates and annotates large argument sets rather than embedding them in full', () => {
    const args = { payload: 'x'.repeat(2000) };
    const summary = summarizeArgsForRagQuery(args);
    expect(summary.length).toBeLessThan(JSON.stringify(args).length);
    expect(summary).toMatch(/truncated, \d+ chars total/);
  });
});

describe('pickRagTool', () => {
  it('prefers search_adobe_knowledge when it is available', () => {
    const available = new Set(['search_adobe_knowledge', 'query_rag_db']);
    expect(pickRagTool(available)).toBe('search_adobe_knowledge');
  });

  it('falls back to another known RAG tool when Adobe search is unavailable', () => {
    const available = new Set(['query_rag_db', 'some_unrelated_tool']);
    expect(pickRagTool(available)).toBe('query_rag_db');
  });

  it('returns undefined when no RAG tool is available to ground a retry', () => {
    const available = new Set(['adobe_create_schema', 'reactor_get_library']);
    expect(pickRagTool(available)).toBeUndefined();
  });
});
