import { Router, type IRouter } from "express";
import { db, treatmentLogsTable, chemicalsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { CreateRecordBody, ApproveRecordBody, GetRecordsQueryParams, GetRecordParams, ApproveRecordParams } from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { writeAudit } from "../lib/audit.js";
import { writeOperationalEvent } from "../lib/operations.js";

const router: IRouter = Router();

router.get("/records", requireAuth, async (req, res) => {
  try {
    const query = GetRecordsQueryParams.safeParse(req.query);
    const status = query.success ? query.data.status : undefined;
    const plotId = query.success && query.data.plotId !== undefined ? Number(query.data.plotId) : undefined;

    let records = await db
      .select()
      .from(treatmentLogsTable)
      .orderBy(desc(treatmentLogsTable.createdAt));

    if (status) {
      records = records.filter((r) => r.approvalStatus === status);
    }
    if (plotId) {
      records = records.filter((r) => r.plotId === plotId);
    }

    res.json(records.map(formatRecord));
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/records", requireAuth, async (req, res) => {
  const startedAt = Date.now();
  try {
    // Use partial() so missing treatmentType is caught by custom validation (→ 422)
    // rather than Zod schema rejection (→ 400)
    const body = CreateRecordBody.partial({ treatmentType: true }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    // Run validation before saving — errors here return 422
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!body.data.treatmentType) {
      errors.push("סוג הטיפול חסר");
    }
    if (!body.data.plotId) warnings.push("מגרש לא צוין");
    if (!body.data.workerName) warnings.push("שם עובד חסר");
    if (!body.data.operationDate) {
      warnings.push("תאריך הפעולה חסר");
    } else {
      const date = new Date(body.data.operationDate);
      if (isNaN(date.getTime())) errors.push("תאריך לא תקין");
      else if (date > new Date()) errors.push("תאריך לא יכול להיות בעתיד");
    }

    let dosageNum: number | null = null;
    if (body.data.dosage) {
      dosageNum = parseFloat(body.data.dosage);
      if (!isNaN(dosageNum) && dosageNum <= 0) {
        errors.push("מינון חייב להיות חיובי");
        dosageNum = null;
      }
    } else {
      warnings.push("מינון חסר");
    }

    if (body.data.chemicalId && dosageNum !== null) {
      const [chemical] = await db
        .select()
        .from(chemicalsTable)
        .where(eq(chemicalsTable.id, body.data.chemicalId))
        .limit(1);
      if (chemical) {
        const minDose = parseFloat(chemical.minDose);
        const maxDose = parseFloat(chemical.maxDose);
        if (dosageNum < minDose) {
          errors.push(`מינון נמוך מהמינימום המותר לחומר ${chemical.name} (מינימום: ${minDose})`);
        } else if (dosageNum > maxDose) {
          errors.push(`מינון גבוה מהמקסימום המותר לחומר ${chemical.name} (מקסימום: ${maxDose})`);
        }
      }
    }

    if (body.data.plotId && body.data.chemicalId && body.data.operationDate) {
      const dateStr = body.data.operationDate;
      const [dup] = await db
        .select({ id: treatmentLogsTable.id })
        .from(treatmentLogsTable)
        .where(
          and(
            eq(treatmentLogsTable.plotId, body.data.plotId),
            eq(treatmentLogsTable.chemicalId, body.data.chemicalId),
            eq(treatmentLogsTable.operationDate, dateStr),
          )
        )
        .limit(1);
      if (dup) {
        warnings.push("נמצא טיפול כפול: אותו חומר ומגרש כבר טופל בתאריך זה");
      }
    }

    if (errors.length > 0) {
      res.status(422).json({ error: "Validation failed", errors, warnings });
      return;
    }

    const derivedValidationStatus =
      warnings.length > 0 ? "warnings" : "valid";

    const [record] = await db
      .insert(treatmentLogsTable)
      .values({
        userId: req.auth!.userId,
        plotId: body.data.plotId ?? null,
        chemicalId: body.data.chemicalId ?? null,
        treatmentType: body.data.treatmentType!,
        materialName: body.data.materialName ?? null,
        dosage: body.data.dosage ?? null,
        waterVolume: body.data.waterVolume ?? null,
        workerName: body.data.workerName ?? null,
        operationDate: body.data.operationDate ?? null,
        notes: body.data.notes ?? null,
        transcription: body.data.transcription ?? null,
        confidenceScore: body.data.confidenceScore ?? null,
        missingFields: body.data.missingFields ?? null,
        validationStatus: body.data.validationStatus ?? derivedValidationStatus,
        approvalStatus: body.data.approvalStatus ?? "pending",
        syncStatus: body.data.syncStatus ?? "synced",
      })
      .returning();

    await writeAudit(req, "record_created", "records", record.id, {
      treatmentType: record.treatmentType,
      plotId: record.plotId,
      chemicalId: record.chemicalId,
      operationDate: record.operationDate,
    });
    await writeOperationalEvent({
      userId: req.auth!.userId,
      eventType: "record_created",
      stage: "record",
      status: warnings.length ? "warning" : "success",
      durationMs: Date.now() - startedAt,
      fallbackUsed: body.data.syncStatus === "failed",
      errorCode: null,
      metadata: {
        hasMissingFields: (record.missingFields?.length ?? 0) > 0,
        missingFieldCount: record.missingFields?.length ?? 0,
        createdFromVoice: Boolean(record.transcription),
      },
    });

    res.status(201).json({ ...formatRecord(record), warnings });
  } catch {
    await writeOperationalEvent({
      userId: req.auth!.userId,
      eventType: "record_create",
      stage: "record",
      status: "error",
      durationMs: Date.now() - startedAt,
      fallbackUsed: false,
      errorCode: "RECORD_CREATE_FAILED",
      metadata: null,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/records/:id", requireAuth, async (req, res) => {
  try {
    const params = GetRecordParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [record] = await db
      .select()
      .from(treatmentLogsTable)
      .where(eq(treatmentLogsTable.id, params.data.id))
      .limit(1);

    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    res.json(formatRecord(record));
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/records/:id/approve", requireAuth, requireRole("admin", "manager", "agronomist"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const params = ApproveRecordParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const body = ApproveRecordBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const [existing] = await db
      .select()
      .from(treatmentLogsTable)
      .where(eq(treatmentLogsTable.id, params.data.id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    const [updated] = await db
      .update(treatmentLogsTable)
      .set({
        approvalStatus: body.data.action,
        approvedAt: new Date(),
        approvedBy: req.auth!.userId,
        notes: body.data.notes ?? existing.notes,
      })
      .where(eq(treatmentLogsTable.id, params.data.id))
      .returning();

    const auditAction = body.data.action === "approved" ? "record_approved" : "record_rejected";
    await writeAudit(req, auditAction, "records", updated.id, {
      previousStatus: existing.approvalStatus,
      notes: body.data.notes ?? null,
    });
    await writeOperationalEvent({
      userId: req.auth!.userId,
      eventType: "record_reviewed",
      stage: "approval",
      status: "success",
      durationMs: Date.now() - startedAt,
      fallbackUsed: false,
      errorCode: null,
      metadata: { decision: body.data.action },
    });

    res.json(formatRecord(updated));
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

function formatRecord(r: typeof treatmentLogsTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    plotId: r.plotId,
    chemicalId: r.chemicalId,
    treatmentType: r.treatmentType,
    materialName: r.materialName,
    dosage: r.dosage,
    waterVolume: r.waterVolume,
    workerName: r.workerName,
    operationDate: r.operationDate,
    notes: r.notes,
    transcription: r.transcription,
    confidenceScore: r.confidenceScore,
    missingFields: r.missingFields,
    validationStatus: r.validationStatus,
    approvalStatus: r.approvalStatus,
    syncStatus: r.syncStatus,
    createdAt: r.createdAt.toISOString(),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    approvedBy: r.approvedBy,
  };
}

export default router;
