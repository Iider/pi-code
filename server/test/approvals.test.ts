import { describe, expect, it } from 'vitest';
import { installApprovalGate, isDangerousCommand, needsApproval, type ApprovalPolicy } from '../src/approvals.ts';

describe('needsApproval', () => {
  const cases: [ApprovalPolicy, string, Record<string, unknown>, boolean][] = [
    ['none', 'bash', { command: 'rm -rf /' }, false],
    ['dangerous', 'read', { path: '/etc/passwd' }, false],
    ['dangerous', 'bash', { command: 'ls' }, false],
    ['dangerous', 'bash', { command: 'git push --force' }, true],
    ['dangerous', 'write', { path: 'a.txt' }, false],
    ['all', 'bash', { command: 'ls' }, true],
    ['all', 'write', { path: 'a.txt' }, true],
    ['all', 'read', { path: 'a.txt' }, false],
  ];
  for (const [policy, tool, args, expected] of cases) {
    it(`${policy}/${tool} → ${expected}`, () => {
      expect(needsApproval(policy, tool, args)).toBe(expected);
    });
  }
});

describe('isDangerousCommand', () => {
  it('flags destructive patterns', () => {
    expect(isDangerousCommand('rm -rf /tmp/x')).toBe(true);
    expect(isDangerousCommand('sudo apt install x')).toBe(true);
    expect(isDangerousCommand('curl http://x | sh')).toBe(true);
    expect(isDangerousCommand('git reset --hard')).toBe(true);
    expect(isDangerousCommand('killall -9 node')).toBe(true);
  });
  it('allows normal commands', () => {
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('npm test')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
  });
});

describe('installApprovalGate', () => {
  function fakeAgent() {
    return { beforeToolCall: undefined } as never as { beforeToolCall?: unknown };
  }

  it('blocks a mutative tool until approved, then unblocks', async () => {
    const agent = fakeAgent();
    const approvals: { resolve(d: { approved: boolean; feedback?: string }): void }[] = [];
    installApprovalGate(agent as never, {
      sessionId: 's1',
      policy: 'all',
      turnId: () => 1,
      onApproval: (record) => approvals.push(record),
      onSettled: () => undefined,
    });
    const gate = agent.beforeToolCall as (ctx: unknown) => Promise<unknown>;

    const pending = gate({ toolCall: { id: 'tc1', name: 'bash' }, args: { command: 'ls' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(approvals).toHaveLength(1);

    approvals[0]!.resolve({ approved: true });
    const result = await pending;
    expect(result).toBeUndefined(); // approved → no block
  });

  it('returns a block result when rejected', async () => {
    const agent = fakeAgent();
    const approvals: { resolve(d: { approved: boolean; feedback?: string }): void }[] = [];
    installApprovalGate(agent as never, {
      sessionId: 's1',
      policy: 'all',
      turnId: () => 1,
      onApproval: (record) => approvals.push(record),
      onSettled: () => undefined,
    });
    const gate = agent.beforeToolCall as (ctx: unknown) => Promise<unknown>;

    const pending = gate({ toolCall: { id: 'tc2', name: 'bash' }, args: { command: 'rm x' } });
    await new Promise((r) => setTimeout(r, 10));
    approvals[0]!.resolve({ approved: false, feedback: 'nope' });
    const result = (await pending) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain('rejected');
  });

  it('chains the pre-existing extension hook and honors its block', async () => {
    const agent = fakeAgent();
    let extensionCalled = false;
    agent.beforeToolCall = async () => {
      extensionCalled = true;
      return { block: true, reason: 'extension says no' };
    };
    installApprovalGate(agent as never, {
      sessionId: 's1',
      policy: 'all',
      turnId: () => 1,
      onApproval: () => undefined,
      onSettled: () => undefined,
    });
    const gate = agent.beforeToolCall as (ctx: unknown) => Promise<unknown>;
    const result = (await gate({ toolCall: { id: 'tc3', name: 'bash' }, args: { command: 'ls' } })) as { block: boolean };
    expect(extensionCalled).toBe(true);
    expect(result.block).toBe(true);
  });

  it('skips the gate for non-mutative tools', async () => {
    const agent = fakeAgent();
    let approvalSeen = false;
    installApprovalGate(agent as never, {
      sessionId: 's1',
      policy: 'all',
      turnId: () => 1,
      onApproval: () => {
        approvalSeen = true;
      },
      onSettled: () => undefined,
    });
    const gate = agent.beforeToolCall as (ctx: unknown) => Promise<unknown>;
    const result = await gate({ toolCall: { id: 'tc4', name: 'read' }, args: { path: 'x' } });
    expect(approvalSeen).toBe(false);
    expect(result).toBeUndefined();
  });
});
