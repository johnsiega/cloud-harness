// One place that decides whether an error is AWS refusing a launch because the account's MicroVM memory limit is reached.
// AWS's real wording for this refusal ("The base maximum allocated memory limit has been reached for this account.")
// does not contain the word "quota", so both forms are matched.
export function isQuotaError(text: string | undefined): boolean {
  return /quota|maximum allocated memory/i.test(text ?? "");
}
