// Decides between real mode and demo mode from the environment. Pure: main.ts passes process.env.
export type Mode = { demo: false; apiKey: string; imageArn: string } | { demo: true; reason: string };

export function resolveMode(env: Record<string, string | undefined>): Mode {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const imageArn = env.MICROVM_IMAGE_ARN?.trim();
  if (env.HARNESS_DEMO === "1") return { demo: true, reason: "real runs are disabled because HARNESS_DEMO=1 is set; unset it and restart to enable them" };
  const missing = [!apiKey && "OPENROUTER_API_KEY", !imageArn && "MICROVM_IMAGE_ARN"].filter(Boolean).join(" and ");
  if (missing) return { demo: true, reason: `real runs are disabled because ${missing} ${missing.includes(" and ") ? "are" : "is"} not set; set ${missing.includes(" and ") ? "them" : "it"} and restart to enable them` };
  return { demo: false, apiKey: apiKey!, imageArn: imageArn! };
}
