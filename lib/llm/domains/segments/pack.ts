/** The segment / audience domain pack. See ../domain-pack.ts. */

import type { DomainPack } from '../domain-pack';
import { resolveSegmentMode, segmentDomainContext, SEGMENT_ALWAYS_ON_TOOLS } from './context';

export const segmentsPack: DomainPack = {
  id: 'segments',
  detect: (input) => resolveSegmentMode(input, input.userInput),
  promptContext: () => [segmentDomainContext()],
  alwaysOnTools: () => SEGMENT_ALWAYS_ON_TOOLS,
};
