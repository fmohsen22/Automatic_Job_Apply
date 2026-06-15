import { Router } from "express";
import { prisma } from "../db.js";
import { defaultDomainPolicies } from "../services/domainPolicies.js";
import { fromJsonString } from "../utils/json.js";

const router = Router();

router.get("/summary", async (_req, res) => {
  const [jobs, cvVersions, docSets, runs, searchRuns, auditEvents] = await Promise.all([
    prisma.job.count(),
    prisma.cvVersion.count(),
    prisma.docSet.count(),
    prisma.applicationRun.count(),
    prisma.searchRun.count(),
    prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 8 })
  ]);

  res.json({
    counts: { jobs, cvVersions, docSets, runs, searchRuns },
    auditEvents: auditEvents.map((event) => ({
      ...event,
      metadata: fromJsonString(event.metadata, null)
    })),
    policies: defaultDomainPolicies
  });
});

export default router;
