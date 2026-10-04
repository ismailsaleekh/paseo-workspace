import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { packageRoot } from "../helpers/pi-harness.js";

interface Violation {
  line: number;
  rule: string;
}
function audit(text: string, filename: string): Violation[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  function add(node: ts.Node, rule: string): void {
    violations.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      rule,
    });
  }
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword)
      add(node, "Replace explicit dynamic typing with a validated named boundary");
    if (ts.isNonNullExpression(node))
      add(node, "Prove presence with control flow instead of a nullability assertion");
    if (ts.isTypeLiteralNode(node) && node.members.length === 0)
      add(node, "Name the actual object shape");
    if (
      ts.isTypeReferenceNode(node) &&
      ["Function", "Object"].includes(node.typeName.getText(source))
    )
      add(node, "Use a precise function or object type");
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      let expression = node.expression;
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression))
        add(node, "Remove the double assertion");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())) {
      violations.push({
        line: source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1,
        rule: "Remove compiler suppression",
      });
    }
  }
  return violations;
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await typescriptFiles(file)));
    else if (/\.tsx?$/.test(entry.name)) result.push(file);
  }
  return result;
}

test("the audit catches type escapes, while strings and narrow literal assertions remain valid", () => {
  for (const snippet of [
    "let value: any;",
    "let value: Array<any>;",
    "let value = input as unknown as string;",
    "let value = input!;",
    "type F = Function;",
    "type O = Object;",
    "type O = {};",
    "// @ts-ignore\nlet value: string = 1;",
    "/* @ts-expect-error */\nlet value: string = 1;",
    "// @ts-nocheck\nlet value;",
  ])
    assert.notEqual(audit(snippet, "detector-fixture.ts").length, 0, snippet);
  assert.deepEqual(
    audit('const text = "any @ts-ignore input!"; const tag = "x" as const;', "valid.ts"),
    [],
  );
});

test("source, entrypoint, helpers and tests contain no prohibited type escapes", async () => {
  const failures: string[] = [];
  for (const directory of ["src", "extensions", "tests"]) {
    for (const file of await typescriptFiles(join(packageRoot, directory))) {
      for (const violation of audit(await readFile(file, "utf8"), file))
        failures.push(`${relative(packageRoot, file)}:${violation.line}: ${violation.rule}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("package compiler checks source and tests with all required strict options", async () => {
  const value: unknown = JSON.parse(await readFile(join(packageRoot, "tsconfig.json"), "utf8"));
  const configuration = z
    .object({
      compilerOptions: z.record(
        z.string(),
        z.union([z.boolean(), z.string(), z.array(z.string())]),
      ),
      include: z.array(z.string()),
    })
    .parse(value);
  for (const option of [
    "strict",
    "noImplicitAny",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "noImplicitThis",
    "alwaysStrict",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noFallthroughCasesInSwitch",
    "noPropertyAccessFromIndexSignature",
    "useUnknownInCatchVariables",
  ]) {
    assert.equal(configuration.compilerOptions[option], true, option);
  }
  assert.equal(configuration.compilerOptions["skipLibCheck"], false);
  assert.equal(configuration.compilerOptions["noEmit"], true);
  assert.equal(configuration.compilerOptions["module"], "ESNext");
  assert.equal(configuration.compilerOptions["moduleResolution"], "Bundler");
  assert.equal(configuration.compilerOptions["resolveJsonModule"], true);
  assert.deepEqual(configuration.include, ["extensions/**/*.ts", "src/**/*.ts", "tests/**/*.ts"]);
});
