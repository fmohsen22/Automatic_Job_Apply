export type AutonomyLevel = "L0" | "L1" | "L2";

export type DomainPolicy = {
  domain: string;
  mode: "allowed" | "assisted-only" | "manual-only";
  risk: "low" | "medium" | "high";
  requiresHumanReviewBeforeSubmit?: boolean;
  captchaAction?: "handoff";
  humanPacedDelayMs?: { min: number; max: number };
  warning?: string;
};

export const defaultDomainPolicies: DomainPolicy[] = [
  {
    domain: "linkedin.com",
    mode: "manual-only",
    risk: "high",
    requiresHumanReviewBeforeSubmit: true,
    captchaAction: "handoff",
    humanPacedDelayMs: { min: 3000, max: 12000 },
    warning: "Automated submissions can violate platform terms and risk account restrictions."
  },
  {
    domain: "greenhouse.io",
    mode: "allowed",
    risk: "low",
    requiresHumanReviewBeforeSubmit: true,
    captchaAction: "handoff",
    humanPacedDelayMs: { min: 1500, max: 6000 }
  },
  {
    domain: "lever.co",
    mode: "allowed",
    risk: "low",
    requiresHumanReviewBeforeSubmit: true,
    captchaAction: "handoff",
    humanPacedDelayMs: { min: 1500, max: 6000 }
  },
  {
    domain: "workdayjobs.com",
    mode: "assisted-only",
    risk: "medium",
    requiresHumanReviewBeforeSubmit: true,
    captchaAction: "handoff",
    humanPacedDelayMs: { min: 2000, max: 8000 },
    warning: "Use human-paced automation and pause on account creation, submit, CAPTCHA, or anti-bot checks."
  }
];

// Sites that require login to apply or are aggregators (not a direct application).
// The job list can hide these so the user focuses on directly-applyable postings.
const GATED_DOMAINS = [
  "linkedin.com",
  "glassdoor.com",
  "glassdoor.de",
  "indeed.com",
  "ziprecruiter.com",
  "monster.com",
  "dice.com",
  "wellfound.com",
  "angel.co",
  "xing.com",
  "stepstone.com",
  "stepstone.de"
];

export function isGatedDomain(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
    return GATED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function policyForUrl(rawUrl: string) {
  const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
  return defaultDomainPolicies.find((policy) => hostname === policy.domain || hostname.endsWith(`.${policy.domain}`)) ?? {
    domain: hostname,
    mode: "assisted-only" as const,
    risk: "medium" as const,
    requiresHumanReviewBeforeSubmit: true,
    captchaAction: "handoff" as const,
    warning: "Unknown domains run in assisted mode and stop before final submission."
  };
}
