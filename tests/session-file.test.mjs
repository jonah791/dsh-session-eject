/**
 * 会话日志定位判据单测 —— 含 2026-09-14 现场尸体样本。
 *
 * 事故：`collectSessionFiles` 旧判据写死 `entry.name === 'session.jsonl.zstd'`，
 * 而线上会话实际叫 `session.v3.jsonl.zstd`（实测 37 个 v3 / 1 个 v2 / 0 个旧名）
 * ⇒ **0 命中**，`session_eject_*` 三个工具全废（真实调用返回 `session=undefined
 * steps=undefined rows=undefined events=undefined`）。本测试把「必须认出 v3 名」
 * 钉成回归，并锁住「旁车文件不许误认」「缺目录不抛」两条边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSessionFiles, isSessionLogName } from '../lib/core.js';

test('尸体样本：三种真实文件名都必须认（v3 / v2 / 旧名）', () => {
  assert.equal(isSessionLogName('session.v3.jsonl.zstd'), true, '线上主名（37 个）被误判 = 三工具全废');
  assert.equal(isSessionLogName('session.v2.jsonl.zstd'), true);
  assert.equal(isSessionLogName('session.jsonl.zstd'), true, '旧名必须保持兼容');
});

test('旁车/无关文件不许误认（正则而非 startsWith）', () => {
  for (const name of [
    'session-backup.jsonl.zstd',
    'session.jsonl',
    'session.v3.jsonl',
    'other.jsonl.zstd',
    'session.v3.jsonl.zstd.bak',
    '',
    'sessionx.v3.jsonl.zstd',
  ]) {
    assert.equal(isSessionLogName(name), false, `不应认作会话：${name}`);
  }
});

test('collectSessionFiles：递归找到嵌套会话（线上布局 sessions/--ws--/<id>/…）', () => {
  const root = mkdtempSync(join(tmpdir(), 'eject-'));
  try {
    mkdirSync(join(root, '--E-alice--', 'session-aaa'), { recursive: true });
    mkdirSync(join(root, '--E-alice--', 'b2700a04'), { recursive: true });
    writeFileSync(join(root, '--E-alice--', 'session-aaa', 'session.v3.jsonl.zstd'), 'x');
    writeFileSync(join(root, '--E-alice--', 'b2700a04', 'session.v3.jsonl.zstd'), 'x');
    writeFileSync(join(root, '--E-alice--', 'session-aaa', 'session.jsonl.zstd.bak'), 'x');
    writeFileSync(join(root, 'readme.txt'), 'x');
    const found = collectSessionFiles(root);
    assert.equal(found.length, 2, `应找到 2 个会话，实际：${JSON.stringify(found)}`);
    assert.ok(found.every((f) => f.endsWith('session.v3.jsonl.zstd')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺目录 / 空目录不抛（调用方可能给出不存在的 root）', () => {
  let missing;
  assert.doesNotThrow(() => {
    missing = collectSessionFiles(join(tmpdir(), 'definitely-absent-eject-dir'));
  });
  assert.deepEqual(missing, [], '缺目录必须返回空表且不抛');

  const empty = mkdtempSync(join(tmpdir(), 'eject-empty-'));
  try {
    assert.deepEqual(collectSessionFiles(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('深度上限：超过 4 层的会话不再扫描（防深层遍历爆栈）', () => {
  const root = mkdtempSync(join(tmpdir(), 'eject-deep-'));
  try {
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'session.v3.jsonl.zstd'), 'x');
    assert.deepEqual(collectSessionFiles(root), [], 'depth>4 不得进入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
