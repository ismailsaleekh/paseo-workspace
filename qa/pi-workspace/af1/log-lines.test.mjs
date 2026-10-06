import assert from "node:assert/strict";
import { test } from "node:test";
import { completeLogLines } from "./log-lines.mjs";

test("a mark at a newline boundary preserves the first appended record", () => {
  const prefix = "old record\n";
  const mark = completeLogLines(prefix).length;
  assert.equal(mark, 1);
  assert.deepEqual(completeLogLines(prefix + "debug block main: 7000 ms\n").slice(mark), [
    "debug block main: 7000 ms",
  ]);
});

test("an initially empty log retains its first record", () => {
  const mark = completeLogLines("").length;
  assert.equal(mark, 0);
  assert.deepEqual(completeLogLines("first\n").slice(mark), ["first"]);
});

test("an incomplete record is deferred rather than counted before it can match", () => {
  const prefix = "old record\npartial";
  const mark = completeLogLines(prefix).length;
  assert.deepEqual(completeLogLines(prefix), ["old record"]);
  assert.deepEqual(completeLogLines(prefix + " record\nnext part").slice(mark), ["partial record"]);
  assert.deepEqual(completeLogLines("no newline yet"), []);
});

test("complete blank lines and CRLF boundaries preserve stable record counts", () => {
  const prefix = "old\r\n\n";
  assert.deepEqual(completeLogLines(prefix), ["old", ""]);
  const mark = completeLogLines(prefix).length;
  assert.deepEqual(completeLogLines(prefix + "new\r\n").slice(mark), ["new"]);
});
