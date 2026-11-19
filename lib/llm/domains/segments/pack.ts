/** The segment / audience domain pack. See ../domain-pack.ts. */

import type { DomainPack } from '../domain-pack';
import { resolveSegmentMode, segmentDomainContext, SEGMENT_ALWAYS_ON_TOOLS } from './context';
import { findProfileFieldsTool } from './find-fields-tool';
import { validateBeforeSegmentWrite } from './validation';

export const segmentsPack: DomainPack = {
  id: 'segments',
  detect: (input) => resolveSegmentMode(input, input.userInput),
  promptContext: () => [segmentDomainContext()],
  alwaysOnTools: () => SEGMENT_ALWAYS_ON_TOOLS,
  // The real-fields-only PQL check gates adobe_create_segment /
  // adobe_update_segment on every run, not only detected segment runs.
  checkToolCall: (toolName, args, { signal }) => validateBeforeSegmentWrite(toolName, args, { signal }),
  localTools: [findProfileFieldsTool],
};
