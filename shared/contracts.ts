export type AutonomyLevel = "L0" | "L1" | "L2";

export const autonomyLabels: Record<AutonomyLevel, string> = {
  L0: "Assist",
  L1: "Semi-auto",
  L2: "Full-auto"
};

export interface LlmProvider {
  rankJob(input: { cv: unknown; jobDescription: string }): Promise<{ score: number; reasons: string[] }>;
  tailorDocuments(input: { cv: unknown; jobDescription: string }): Promise<{
    cv: unknown;
    coverLetter: string;
    checklist: RequirementsChecklistItem[];
  }>;
}

export interface SearchProvider {
  search(input: { city: string; role: string; filters?: Record<string, unknown> }): Promise<NormalizedJob[]>;
}

export interface AtsAdapter {
  id: string;
  canHandle(url: URL): boolean;
  planApplication(input: { jobUrl: string; autonomyLevel: AutonomyLevel; dryRun: boolean }): Promise<unknown>;
}

export interface NormalizedJob {
  source: string;
  url: string;
  company: string;
  title: string;
  location?: string;
  description: string;
}

export interface RequirementsChecklistItem {
  requirement: string;
  status: "met" | "missing" | "address";
  evidence?: string;
  plan?: string;
}

export interface DomainPolicy {
  domain: string;
  mode: "allowed" | "assisted-only" | "manual-only";
  risk: "low" | "medium" | "high";
  requiresHumanReviewBeforeSubmit?: boolean;
  captchaAction?: "handoff";
  humanPacedDelayMs?: { min: number; max: number };
  warning?: string;
}

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
