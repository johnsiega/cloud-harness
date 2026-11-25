// The listing in the AWS adapter, with a fake SDK client. Run: node --test tests/unit/aws-microvms.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAwsMicrovms } from "../../api/aws-microvms.ts";

const IMAGE = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq";

function fakeClient(pages: { items?: { microvmId?: string; state?: string }[]; nextToken?: string }[]) {
  const inputs: any[] = [];
  let i = 0;
  const client = {
    send: async (cmd: any) => {
      inputs.push(cmd.input);
      return pages[i++] ?? { items: [] };
    },
  };
  return { client, inputs };
}

describe("AwsMicrovms.list", () => {
  test("follows nextToken until the last page and returns every MicroVM in order", async () => {
    const { client, inputs } = fakeClient([
      { items: [{ microvmId: "a", state: "RUNNING" }, { microvmId: "b", state: "SUSPENDED" }], nextToken: "t1" },
      { items: [{ microvmId: "c", state: "TERMINATED" }], nextToken: "t2" },
      { items: [{ microvmId: "d", state: "RUNNING" }] },
    ]);
    const out = await createAwsMicrovms({ region: "us-east-1", client }).list();
    assert.deepEqual(out, [
      { microvmId: "a", state: "RUNNING" }, { microvmId: "b", state: "SUSPENDED" },
      { microvmId: "c", state: "TERMINATED" }, { microvmId: "d", state: "RUNNING" },
    ]);
    assert.deepEqual(inputs.map((x) => x.nextToken), [undefined, "t1", "t2"]);
  });

  test("with no image, the request has no imageIdentifier at all (every MicroVM, not one image's)", async () => {
    const { client, inputs } = fakeClient([{ items: [] }]);
    await createAwsMicrovms({ region: "us-east-1", client }).list();
    assert.equal(inputs.length, 1);
    assert.ok(!("imageIdentifier" in inputs[0]), `unexpected imageIdentifier: ${JSON.stringify(inputs[0])}`);
  });

  test("with an image, every page request carries that imageIdentifier", async () => {
    const { client, inputs } = fakeClient([{ items: [{ microvmId: "a", state: "RUNNING" }], nextToken: "t1" }, { items: [] }]);
    await createAwsMicrovms({ region: "us-east-1", client }).list(IMAGE);
    assert.equal(inputs.length, 2);
    for (const x of inputs) assert.equal(x.imageIdentifier, IMAGE);
  });

  test("items without a microvmId are skipped, and an empty page gives an empty list", async () => {
    const { client } = fakeClient([{ items: [{ state: "RUNNING" }, { microvmId: "a", state: "RUNNING" }] }]);
    assert.deepEqual(await createAwsMicrovms({ region: "us-east-1", client }).list(), [{ microvmId: "a", state: "RUNNING" }]);
    const empty = fakeClient([{}]);
    assert.deepEqual(await createAwsMicrovms({ region: "us-east-1", client: empty.client }).list(), []);
  });
});
