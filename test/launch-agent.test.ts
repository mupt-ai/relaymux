import assert from "node:assert/strict";
import test from "node:test";

import { renderLaunchAgentPlist } from "../src/launch-agent.js";


test("renderLaunchAgentPlist escapes XML and includes daemon args", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux",
    programArguments: ["/bin/node", "/tmp/a&b/relaymux", "daemon"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
  });

  assert.match(plist, /<string>com.example.relaymux<\/string>/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
});
