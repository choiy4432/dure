import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDirOf, existingSessions } from '../src/engine/claudeSessions';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-cs-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('폴더마다 <id>.jsonl 이 있는지만 본다', () => {
  fs.mkdirSync(path.join(dir, 'projects', 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'a', 'S1.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'projects', 'b', 'S2.jsonl'), '');
  expect(existingSessions(dir, ['S1', 'S2', 'S3'])).toEqual(new Set(['S1', 'S2']));
});

test('projects 가 없으면 빈 Set', () => {
  expect(existingSessions(dir, ['S1'])).toEqual(new Set());
});

test('설정 폴더: 엔진 env → 프로세스 env → ~/.claude', () => {
  expect(claudeDirOf({ CLAUDE_CONFIG_DIR: 'X' })).toBe('X');
  const keep = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeDirOf(undefined)).toBe(path.join(os.homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = 'Y';
    expect(claudeDirOf({})).toBe('Y');
  } finally {
    if (keep === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = keep;
  }
});
