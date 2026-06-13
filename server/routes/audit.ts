import { Router } from "express";
import { prisma } from "../db.js";
import { fromJsonString } from "../utils/json.js";

const router = Router();

router.get("/", async (_req, res) => {
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json(events.map((event) => ({
    ...event,
    metadata: fromJsonString(event.metadata, null)
  })));
});

export default router;
