import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/3ds-return.js", import.meta.url), "utf8");
const state = "8adf1435-9b53-4f2e-8ff1-6a1cf98a252f";
function callback(search, framed = true) {
  const messages = [], element = {}, historyCalls = [];
  const window = { parent: { postMessage: (...args) => messages.push(args) } };
  if (!framed) window.parent = window;
  vm.runInNewContext(source, { window, URLSearchParams, location: { origin: "https://test.example", pathname: "/3ds-return", search },
    history: { replaceState: (...args) => historyCalls.push(args) }, document: { getElementById: () => element } });
  return { messages, element, historyCalls };
}

test("3DS callback sends only a correlated notification to its same-origin parent", () => {
  for (const result of ["return", "cancel"]) {
    const page = callback(`?state=${state}&result=${result}&token=untrusted-provider-token`);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0][1], "https://test.example");
    assert.equal(JSON.stringify(page.messages[0][0]), JSON.stringify({ type: "editfi:3ds-result", state, result }));
    assert.equal(page.historyCalls[0][2], "/3ds-return");
    assert.equal(JSON.stringify(page.messages).includes("untrusted-provider-token"), false);
  }
});

test("invalid 3DS callback states/results and standalone visits cannot request a checkout action", () => {
  for (const search of ["", `?state=${state}&result=success`, "?state=bad&result=return", `?state=${state}`]) {
    assert.equal(callback(search).messages.length, 0);
  }
  assert.equal(callback(`?state=${state}&result=return`, false).messages.length, 0);
});
