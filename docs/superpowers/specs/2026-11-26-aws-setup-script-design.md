# One-command AWS setup script: design

Status: **draft, waiting for the owner's approval.** Written on 2026-11-26 and not yet implemented. One question below blocks the real test.

## Blocking question for the owner: how do we test it?

The script creates IAM resources, so it needs **admin-level AWS access**: IAM, CloudFormation, S3 and Lambda MicroVMs. The owner's everyday user, `kumpas-harness`, is deliberately narrow and must stay that way, and root is retired. Choose one:

- **A. A separate, clean AWS account** with an admin principal there (Identity Center or a temporary admin user).
  - It is the only true "clean account" test, and the one the README claims.
  - Risk: new accounts get a reduced MicroVM memory quota, and MicroVMs may need to be enabled first, so even one run may need a quota check.
- **B. This account, with a temporary admin principal** that the owner creates in the Console and deletes afterwards. It uses its own prefix (`throwbox-test`), so it never touches the live `hq-smoke-*` bucket, role or images, or the `kumpas-harness` user.
  - It proves create, re-run, teardown and the scoped policy.
  - It does not prove a clean account: existing account settings, such as MicroVMs already being enabled, are inherited.

Either way, `kumpas-harness` never gets admin rights, and I never handle the admin credentials: the owner sets the profile.

## Problem

The README's step 2 ("One-time AWS setup") is a paragraph of IAM prose. It was followed once, by hand, on one account, and has never been repeated. A newcomer has to turn it into a bucket, a role, a user and two policies without a mistake.

## Behaviour

`npm run setup:aws` with an admin profile:

1. **Shows the plan and changes nothing.** This is the default, the same pattern as `scripts/kill-all.ts`. It prints:
   - the caller identity (account and ARN, to the local terminal only);
   - the CloudFormation change set: each resource, with the action Add, Modify or Remove;
   - **the exact policy statements** for the build role and the scoped user, because a change set does not show policy text;
   - whether an image will be built.
2. **`--yes` applies it.** It creates or updates the stack `<prefix>` (default prefix `throwbox`), then builds the MicroVM image unless a `CREATED` image named `<prefix>-*` already exists (`--rebuild-image` forces a new one). At the end it prints the lines to copy:
   - `MICROVM_IMAGE_ARN`, `SMOKE_BUCKET` and `SMOKE_BUILD_ROLE_ARN`;
   - the scoped user's name;
   - how to create that user's access key **in the Console**, and how to make a profile for it.
3. **Re-runnable.**
   - A second run with nothing changed reports "nothing to change" and exits 0. CloudFormation marks an empty change set as `FAILED` with "didn't contain changes", and the script treats that as success.
   - An edited template becomes an update.
   - The image step is skipped while an image exists.
4. **`--teardown`** shows what it would delete, and `--teardown --yes` deletes it, in this order:
   1. terminate MicroVMs started from `<prefix>-*` images;
   2. delete those images;
   3. delete the scoped user's access keys (IDs printed masked, as `AKIA…` plus the last 4 characters);
   4. empty the bucket;
   5. delete the stack and wait for it to finish.

   Teardown only touches the stack named `<prefix>` and images named `<prefix>-*`. It refuses the prefix `hq-smoke`, the owner's live setup.

## What it creates (CloudFormation, `scripts/setup/throwbox-aws.json`)

JSON, not YAML, so tests can read the exact policy statements without a dependency.

| Resource | Details |
|---|---|
| Bucket `<prefix>-images-<account>-<region>` | Public access blocked, SSE-S3 encryption, no versioning (so teardown can empty it). Holds only the image zip. |
| Build role `<prefix>-microvm-build` | Trusted by `lambda.amazonaws.com`. Allowed: `s3:GetObject` on the bucket, and creating and writing logs under `/aws/lambda-microvms/*`. |
| User `<prefix>-operator` with one inline policy | `lambda:*Microvm*`; `lambda:PassNetworkConnector` on the two managed connectors (`HTTP_INGRESS`, `INTERNET_EGRESS`); `s3:PutObject` and `s3:GetObject` on the bucket; `iam:PassRole` on the build role, only to `lambda.amazonaws.com`; reading `/aws/lambda-microvms/*` logs. Nothing else. |
| Outputs | Bucket name, build role ARN, user name. No secrets. |

**No access key resource and no `create-access-key` call.** The owner creates the access key in the Console and puts it in their own AWS profile, so the script never sees, prints or stores a secret.

The image build reuses the code path in `scripts/smoke-test.ts`, moved into an exported `buildImage()`. `npm run smoke` keeps working exactly as before, including its image name `hq-smoke-<timestamp>`. The setup script uses `<prefix>-<timestamp>`.

## Error handling

- **Access denied:** "this step needs admin-level AWS access (IAM, CloudFormation, S3, Lambda MicroVMs); run it with an admin profile". The AWS text follows on stderr. It never contains secrets, because no secret exists in this flow.
- **Stack in a failed state** (such as `ROLLBACK_COMPLETE`): the script prints the stack's failure events and tells the owner to run `--teardown --yes` and start again. It never deletes anything on its own.
- **Image build `FAILED`:** the CloudWatch log group to read, as `smoke-test.ts` does today.
- **Wrong region:** the script states that MicroVMs were only tested in `us-east-1`. It does not block other regions.

## Testing (written first, with a "tests approved" gate)

Fake `aws` CLI runner only, injected:
- the template: exact policy statements, least privilege (no `*` action outside `lambda:*Microvm*`), no access key resource, outputs with no secrets;
- dry run by default: no create, execute or delete call is made without `--yes`;
- the plan shows the change set and the policy text before anything is applied;
- create versus update; an empty change set counts as success; the image is skipped when one exists;
- teardown order, its dry run, the masked access key ids, the refusal of `hq-smoke`, and that only `<prefix>-*` images are touched;
- `buildImage()`: the upload, the create call with the hooks, waiting, a `FAILED` image; and `smoke-test.ts` still builds an `hq-smoke-*` name.

## Real checks (each one is its own go, depending on the answer above)

1. A dry run with the admin profile. Free.
2. `--yes`: the stack and one image build. About 3 minutes; the image build cost is not measured.
3. A re-run with nothing changed: "nothing to change".
4. The owner creates the scoped user's access key and profile. Then **one real run as that user** through the control plane. This is the only proof that the policy is complete. Cost: a few cents.
5. `--teardown --yes`: everything is gone, checked with `describe-stacks` and `list-microvm-images`.

## Not verified yet (to check in AWS docs before building)

- The build role's trust principal and its exact log permissions. Today they come from the README, not from the live role.
- The live `kumpas-harness` policy has not been read; that user cannot read IAM. The template is rebuilt from the README. Real check 4 is the proof.
- The CLI names and filters for listing and deleting images (`list-microvm-images`, `delete-microvm-image`).
- Whether deleting the stack fails while the user still has access keys made outside it. The script deletes them first either way.

## Out of scope

Other clouds and regions, Terraform or CDK, creating OpenRouter or GitHub tokens, raising quotas, and a hosted installer.
