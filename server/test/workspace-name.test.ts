import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { workspaceName } from '../src/bridge.ts';

describe('workspaceName', () => {
  it('uses the final directory name instead of a home-relative path', () => {
    const root = join(tmpdir(), 'parent', 'project-name');
    expect(workspaceName(root)).toBe(basename(root));
  });
});
