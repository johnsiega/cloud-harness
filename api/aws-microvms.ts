// Thin real AWS layer behind the AwsMicrovms seam. No logic worth unit-testing: it is exercised by the integration test.
// Credentials come from the SDK default chain (set AWS_PROFILE=<your-profile>); never pass keys in code.
import { CreateMicrovmAuthTokenCommand, LambdaMicrovmsClient, RunMicrovmCommand, TerminateMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import type { AwsMicrovms } from "./types.ts";

export function createAwsMicrovms(o: { region: string }): AwsMicrovms {
  const client = new LambdaMicrovmsClient({ region: o.region });
  return {
    async run(input) {
      const r = await client.send(new RunMicrovmCommand(input));
      if (!r.microvmId || !r.endpoint) throw new Error("run-microvm returned no microvmId/endpoint");
      return { microvmId: r.microvmId, endpoint: r.endpoint };
    },
    async authToken(microvmId) {
      const r = await client.send(new CreateMicrovmAuthTokenCommand({ microvmIdentifier: microvmId, expirationInMinutes: 60, allowedPorts: [{ allPorts: {} }] }));
      const token = (r.authToken as Record<string, string> | undefined)?.["X-aws-proxy-auth"];
      if (!token) throw new Error("create-microvm-auth-token returned no token");
      return token;
    },
    async terminate(microvmId) {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    },
  };
}
