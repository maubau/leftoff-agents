import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { describeInstalled, mergeHooks, removeHooks, type HookMap } from "../src/hosts/hookmap.ts";

const SPEC = [{ event: "Stop", command: "leftoff hook claude-code stop", timeoutSec: 20 }];

test("adds a hook to an empty config", () => {
  const { map, installed } = mergeHooks({}, SPEC);
  deepStrictEqual(installed, ["Stop"]);
  strictEqual(map["Stop"]?.[0]?.hooks[0]?.command, "leftoff hook claude-code stop");
});

test("is idempotent", () => {
  const first = mergeHooks({}, SPEC);
  const second = mergeHooks(first.map, SPEC);
  deepStrictEqual(second.installed, []);
  deepStrictEqual(second.alreadyPresent, ["Stop"]);
  strictEqual(second.map["Stop"]?.length, 1);
});

test("updates our own entry in place when the command changes", () => {
  const first = mergeHooks({}, SPEC);
  const moved = mergeHooks(first.map, [{ ...SPEC[0]!, command: "/opt/leftoff hook claude-code stop" }]);
  strictEqual(moved.map["Stop"]?.[0]?.hooks.length, 1);
  strictEqual(moved.map["Stop"]?.[0]?.hooks[0]?.command, "/opt/leftoff hook claude-code stop");
});

test("never touches hooks the user installed", () => {
  const theirs: HookMap = {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "make lint" }] }],
  };
  const { map } = mergeHooks(theirs, SPEC);
  strictEqual(map["Stop"]?.length, 2);

  const { map: after, removed } = removeHooks(map);
  deepStrictEqual(removed, ["Stop"]);
  strictEqual(after["Stop"]?.length, 1);
  strictEqual(after["Stop"]?.[0]?.hooks[0]?.command, "make lint");
});

test("drops the event entirely once only our hook was there", () => {
  const { map } = mergeHooks({}, SPEC);
  const { map: after } = removeHooks(map);
  deepStrictEqual(after, {});
});

test("flags hooks pointing at another binary as stale", () => {
  const { map } = mergeHooks({}, SPEC);
  const { installed, stale } = describeInstalled(map, "/usr/local/bin/leftoff");
  deepStrictEqual(installed, ["Stop"]);
  strictEqual(stale.length, 1);
});
