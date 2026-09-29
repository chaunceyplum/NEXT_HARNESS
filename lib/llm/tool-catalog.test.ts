import { describe, expect, it } from 'vitest';
import {
  capRagResult,
  capToolResult,
  isAdobeScoped,
  isNonRetryableError,
  isRateLimitError,
  isUninformativeError,
  isValidationError,
  pickRagTool,
  summarizeArgsForRagQuery,
  summarizeFindingsForRetryHistory,
} from './tool-catalog';

describe('isAdobeScoped', () => {
  it('keeps Adobe and other in-scope tools', () => {
    for (const name of ['adobe_create_schema', 'cja_list_projects', 'reactor_get_library', 'execute_sql', 'msb_github_commit_code']) {
      expect(isAdobeScoped(name)).toBe(true);
    }
  });

  it('keeps the Tier 1/2 AEP tools added on top of the original 139 (Schema Registry, Ingestion, Profile, Sandbox, Identity, Privacy, Segmentation jobs, Flow runs)', () => {
    for (const name of [
      'adobe_list_classes',
      'adobe_create_field_group',
      'adobe_create_batch',
      'adobe_get_profile_entity',
      'adobe_create_sandbox',
      'adobe_create_identity_namespace',
      'adobe_create_privacy_job',
      'adobe_create_segment_job',
      'adobe_create_export_job',
      'flow_list_runs',
      'flow_get_run',
    ]) {
      expect(isAdobeScoped(name)).toBe(true);
    }
  });

  it('keeps the follow-up AEP tools rounding out Flow Service, Segmentation, and Data Prep (218 -> 238)', () => {
    for (const name of [
      'adobe_create_segment_estimate',
      'adobe_get_segment_estimate',
      'flow_get_connection_spec',
      'flow_list_flow_specs',
      'flow_get_flow_spec',
      'flow_get_landing_zone_credentials',
      'flow_enable',
      'flow_disable',
      'dataprep_list_mapping_sets',
      'dataprep_create_mapping_set',
      'dataprep_create_mapping',
      'dataprep_preview_mapping',
      'dataprep_list_mapping_functions',
    ]) {
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

describe('summarizeFindingsForRetryHistory', () => {
  it('passes small findings through untouched, unstringified', () => {
    const findings = { results: ['a short answer'] };
    expect(summarizeFindingsForRetryHistory(findings)).toBe(findings);
  });

  it('truncates and annotates large findings rather than embedding them in full', () => {
    const findings = { results: Array(50).fill('x'.repeat(200)) };
    const summary = summarizeFindingsForRetryHistory(findings);
    expect(typeof summary).toBe('string');
    expect((summary as string).length).toBeLessThan(JSON.stringify(findings).length);
    expect(summary).toMatch(/truncated, \d+ chars total/);
  });
});

describe('capRagResult', () => {
  it('passes small results through untouched, unstringified', () => {
    const result = { results: ['a short, useful answer'] };
    expect(capRagResult(result)).toBe(result);
  });

  it('truncates and annotates a large result rather than returning it in full', () => {
    const result = { results: Array(200).fill('x'.repeat(200)) };
    const capped = capRagResult(result);
    expect(typeof capped).toBe('string');
    expect((capped as string).length).toBeLessThan(JSON.stringify(result).length);
    expect(capped).toMatch(/truncated, \d+ chars total/);
  });

  it('is generous enough to preserve a genuine multi-paragraph explanatory answer', () => {
    const result = { answer: 'A merge policy determines which record wins when identities merge. '.repeat(20) };
    expect(capRagResult(result)).toBe(result);
  });
});

describe('pickRagTool', () => {
  it('prefers search_adobe_knowledge when it is available', () => {
    const available = new Set(['search_adobe_knowledge', 'query_rag_db']);
    expect(pickRagTool('adobe_create_schema', available)).toBe('search_adobe_knowledge');
  });

  it('falls back to another known RAG tool when Adobe search is unavailable', () => {
    const available = new Set(['query_rag_db', 'some_unrelated_tool']);
    expect(pickRagTool('adobe_create_schema', available)).toBe('query_rag_db');
  });

  it('returns undefined when no RAG tool is available to ground a retry', () => {
    const available = new Set(['adobe_create_schema', 'reactor_get_library']);
    expect(pickRagTool('adobe_create_schema', available)).toBeUndefined();
  });

  it('never grounds a failed GitHub tool with Adobe knowledge search, even when it is available', () => {
    const available = new Set(['search_adobe_knowledge', 'query_rag_db']);
    expect(pickRagTool('msb_github_commit_code', available)).toBeUndefined();
    expect(pickRagTool('msb_github_create_branch', available)).toBeUndefined();
    expect(pickRagTool('github_read_file', available)).toBeUndefined();
    expect(pickRagTool('github_list_directory', available)).toBeUndefined();
  });
});

describe('isValidationError', () => {
  it('matches 4xx argument errors in MCP / HTTP message shapes', () => {
    for (const m of ['422: {"errorCode":"x"}', 'HTTP 400', 'Request failed with status code 404', 'Schema already exists']) {
      expect(isValidationError(m), m).toBe(true);
    }
  });

  it('does not match bare numbers, rate limits, auth errors, or 5xx', () => {
    for (const m of ['timed out after 400 ms', 'segment 400123 failed', '429: Too Many Requests', '403: forbidden', '500 Internal Server Error']) {
      expect(isValidationError(m), m).toBe(false);
    }
  });
});

describe('isRateLimitError', () => {
  it('treats 429 / rate limit messages as rate limits', () => {
    expect(isRateLimitError('429: Too Many Requests')).toBe(true);
    expect(isRateLimitError('Rate limit exceeded')).toBe(true);
    expect(isRateLimitError('422: bad field')).toBe(false);
  });
});

describe('capToolResult', () => {
  it('passes through undefined results instead of throwing', () => {
    expect(capToolResult('t', undefined)).toBeUndefined();
  });
});

describe('isUninformativeError', () => {
  it('flags bare status lines', () => {
    for (const m of ['400: Bad Request', '422 Unprocessable Entity', 'HTTP 404 Not Found', 'Validation error']) {
      expect(isUninformativeError(m), m).toBe(true);
    }
  });

  it('does not flag errors that name what is wrong', () => {
    for (const m of ['422: field "meta:class" is required', '400: segment name already exists', '404: schema _tenant.loyalty not found']) {
      expect(isUninformativeError(m), m).toBe(false);
    }
  });
});
