import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = new URL("../../content-src/brainstorm/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, source), "utf8");
const workflow = JSON.parse(read("workflows/brainstorm.workflow.json"));
const handlers = JSON.parse(read("catalog/activity-handlers.json")).handlers;
const classifier = read("skills/roles/classifier.md");

test("the user-selected argument count enters the shared input through the host activity", () => {
  const parameter = workflow.params.argumentSteps;
  assert.deepEqual(
    { default: parameter.default, min: parameter.min, max: parameter.max },
    { default: 6, min: 3, max: 9 },
  );
  for (const value of [parameter.default, parameter.min, parameter.max]) {
    assert.equal(Number.isInteger(value), true);
  }
  const apply = workflow.root.steps.find((step: { id: string }) => step.id === "apply-classification");
  assert.equal(apply.handler, "classification.apply");
  assert.equal(apply.bind.argumentSteps, "params.argumentSteps");
  assert.deepEqual(handlers[apply.handler].inputs.argumentSteps, { kind: "positiveInteger" });
  assert.equal(apply.output.key, "input");
  assert.equal(apply.output.schema, "processorOutput");
  const firstPass = workflow.root.steps.find((step: { id: string }) => step.id === "first-pass");
  assert.equal(firstPass.body.bind.cotSteps, "input.cotSteps", "panel agents consume the host-selected count");
});

test("classifier instructions receive the same route settings used by retrieval", () => {
  const classify = workflow.root.steps.find((step: { id: string }) => step.id === "classify-input");
  const variables = /^vars: \[([^\]]+)\]/m.exec(classifier)![1]!.split(",").map((value) => value.trim());
  for (const key of ["routeKeyTerms", "equivalentProblemWeight"]) {
    assert.equal(classify.bind[key], `params.${key}`);
    assert.ok(variables.includes(key));
    assert.ok(classifier.includes(`{{${key}}}`), `${key} is visible to the model`);
  }
  assert.equal(workflow.params.routeKeyTerms.default, false);
  assert.equal(workflow.params.equivalentProblemWeight.default, 0);
  const result = classifier.slice(classifier.indexOf("# Result"));
  assert.doesNotMatch(result, /^- `cotSteps`:/m);
  assert.doesNotMatch(result, /`kind`|`field`/);
  assert.match(result, /confidence` only for a positive equivalent-problem weight/);
  assert.match(result, /`keyTerms` only when enabled/);
  assert.match(result, /one short grounded sentence/);
});

test("the changed classifier contract declares its required app version", () => {
  const bundle = JSON.parse(read("bundle.json"));
  assert.equal(workflow.version, "0.33.0");
  assert.equal(bundle.minAppVersion, "0.2.94");
});
